import os
import subprocess
import sys
import logging
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from flask_socketio import SocketIO
from sqlalchemy import inspect, text
from config import Config
from models import db, Admin, ComplaintStatus, Department
from routes.auth import auth_bp
from routes.complaints import complaints_bp
from routes.admin import admin_bp
from routes.official import official_bp
from routes.user import user_bp
from routes.ai import ai_bp, validate_image
from routes.emergency import emergency_bp
from utils import hash_password
from ai_service import load_yolo_model, yolo_status
from services.alert_service import process_overdue_complaints

# Create SocketIO instance (initialized later with the app)
socketio = SocketIO(cors_allowed_origins="*")


def migrate_database(app):
    with app.app_context():
        db.create_all()
        inspector = inspect(db.engine)
        if 'admins' in inspector.get_table_names():
            existing_columns = [col['name'] for col in inspector.get_columns('admins')]
            with db.engine.begin() as conn:
                if 'admin_id' not in existing_columns:
                    conn.execute(text('ALTER TABLE admins ADD COLUMN admin_id VARCHAR(64)'))
                if 'phone' not in existing_columns:
                    conn.execute(text('ALTER TABLE admins ADD COLUMN phone VARCHAR(24)'))
                if 'department' not in existing_columns:
                    conn.execute(text('ALTER TABLE admins ADD COLUMN department VARCHAR(120)'))
                for column, definition in [('state', 'VARCHAR(120)'), ('district', 'VARCHAR(100)'), ('taluk', 'VARCHAR(100)')]:
                    if column not in existing_columns:
                        conn.execute(text(f'ALTER TABLE admins ADD COLUMN {column} {definition}'))
        for table in ('users', 'officials'):
            if table in inspector.get_table_names():
                existing_columns = [col['name'] for col in inspector.get_columns(table)]
                if 'state' not in existing_columns:
                    with db.engine.begin() as conn:
                        conn.execute(text(f'ALTER TABLE {table} ADD COLUMN state VARCHAR(120)'))
        if 'complaints' in inspector.get_table_names():
            existing_columns = [col['name'] for col in inspector.get_columns('complaints')]
            if 'priority_score' not in existing_columns:
                with db.engine.begin() as conn:
                    conn.execute(text('ALTER TABLE complaints ADD COLUMN priority_score INTEGER NOT NULL DEFAULT 0'))
            for column, definition in [('ai_category', 'VARCHAR(120)'), ('ai_confidence', 'FLOAT'), ('sla_target_hours', 'INTEGER'), ('sla_due_at', 'DATETIME'), ('reminder_sent_at', 'DATETIME'), ('escalated_at', 'DATETIME'), ('cluster_id', 'INTEGER')]:
                if column not in existing_columns:
                    with db.engine.begin() as conn:
                        conn.execute(text(f'ALTER TABLE complaints ADD COLUMN {column} {definition}'))
        if 'images' in inspector.get_table_names():
            existing_columns = [col['name'] for col in inspector.get_columns('images')]
            if 'phase' not in existing_columns:
                with db.engine.begin() as conn:
                    conn.execute(text('ALTER TABLE images ADD COLUMN phase VARCHAR(64)'))
            if 'media_type' not in existing_columns:
                with db.engine.begin() as conn:
                    conn.execute(text("ALTER TABLE images ADD COLUMN media_type VARCHAR(16) NOT NULL DEFAULT 'image'"))
        if 'evidence_validations' in inspector.get_table_names():
            validation_columns = [col['name'] for col in inspector.get_columns('evidence_validations')]
            if 'user_id' not in validation_columns:
                with db.engine.begin() as conn:
                    conn.execute(text('ALTER TABLE evidence_validations ADD COLUMN user_id INTEGER'))
            if 'candidate_category' not in validation_columns:
                with db.engine.begin() as conn:
                    conn.execute(text('ALTER TABLE evidence_validations ADD COLUMN candidate_category VARCHAR(120)'))
        # Early development builds stored some official department values as
        # labels (for example "road") instead of department foreign keys.
        # Normalise those records once so department-level access works.
        if 'officials' in inspector.get_table_names() and 'departments' in inspector.get_table_names():
            department_aliases = {
                'road': 'Road Department', 'roads': 'Road Department',
                'water': 'Water Supply Department', 'garbage': 'Garbage/Waste Management Department',
                'drainage': 'Drainage Department', 'street light': 'Street Light Department',
                'electricity': 'Electrical Department', 'tree': 'Tree/Public Works Department',
            }
            with db.engine.begin() as conn:
                for legacy_value, department_name in department_aliases.items():
                    department_id = conn.execute(text('SELECT id FROM departments WHERE name = :name'), {'name': department_name}).scalar()
                    if department_id is not None:
                        conn.execute(text('UPDATE officials SET department_id = :department_id WHERE lower(CAST(department_id AS TEXT)) = :legacy_value'), {'department_id': department_id, 'legacy_value': legacy_value})


def seed_defaults(app):
    with app.app_context():
        migrate_database(app)
        for department_name, description in [
            ('Road Department', 'Road damage, potholes, and road-related complaints'),
            ('Garbage/Waste Management Department', 'Garbage overflow and illegal dumping'),
            ('Water Supply Department', 'Water leakage and water supply issues'),
            ('Drainage Department', 'Drainage blockage and flood-related drainage issues'),
            ('Street Light Department', 'Broken street-light complaints'),
            ('Tree/Public Works Department', 'Fallen trees and public-works issues'),
            ('Electrical Department', 'Electric pole damage and electrical civic issues'),
            ('Fire and Rescue Department', 'Fire, smoke, and rescue emergencies'),
            ('Health and Ambulance Department', 'Medical emergencies and ambulance response'),
            ('Animal Welfare Department', 'Animal welfare and safety incidents'),
            ('Public Works Department', 'Damage to public property and civic infrastructure'),
            ('Traffic Management Department', 'Traffic signal and traffic control issues'),
            ('General Civic Department', 'Uncategorised civic complaints'),
        ]:
            if not Department.query.filter_by(name=department_name).first():
                db.session.add(Department(name=department_name, description=description))

        for status_name, description in [
            ('Submitted', 'Complaint submitted and awaiting review'),
            ('Accepted', 'Complaint has been accepted for action by an official'),
            ('In Progress', 'Complaint is being actively worked on'),
            ('Rejected', 'Complaint was reviewed and rejected'),
            ('Resolved', 'Complaint has been resolved'),
            ('Escalated', 'Complaint has been escalated to a higher authority')
        ]:
            if not ComplaintStatus.query.filter_by(name=status_name).first():
                db.session.add(ComplaintStatus(name=status_name, description=description))
        db.session.commit()


def ensure_trained_model():
    model_path = os.path.join(os.path.dirname(__file__), 'trained_models', 'complaint_text_model.joblib')
    if os.path.exists(model_path):
        return True
    dataset_dir = os.path.join(os.path.dirname(__file__), 'datasets', 'complaints')
    if not os.path.isdir(dataset_dir):
        return False
    csv_files = [name for name in os.listdir(dataset_dir) if name.endswith('.csv')]
    if not csv_files:
        return False
    training_script = os.path.join(os.path.dirname(__file__), 'scripts', 'train_text_classifier.py')
    if os.path.exists(training_script):
        subprocess.run([sys.executable, training_script], check=False, capture_output=True, text=True)
    return os.path.exists(model_path)


def create_app():
    app = Flask(__name__, static_folder=None)
    logging.getLogger().setLevel(os.environ.get('LOG_LEVEL', 'INFO').upper())
    app.logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO').upper())
    app.config.from_object(Config)
    Config.validate_production_settings()
    app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
    app.config['MAX_CONTENT_LENGTH'] = int(os.environ.get('MAX_UPLOAD_BYTES', 10 * 1024 * 1024))
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

    cors_origins = list(Config.CORS_ORIGINS) or ('*' if Config.ENVIRONMENT != 'production' else [])
    CORS(app, resources={r"/*": {"origins": cors_origins}}, supports_credentials=True, allow_headers=['Content-Type', 'Authorization'])
    db.init_app(app)
    migrate_database(app)
    seed_defaults(app)
    jwt = JWTManager(app)

    ensure_trained_model()
    # Validate the real detector once at startup. A bad/missing model never
    # crashes the API; validation requests receive the explicit status instead.
    load_yolo_model()

    # Initialize SocketIO with the Flask app
    socketio.init_app(app, cors_allowed_origins='*')
    app.extensions['socketio'] = socketio

    # Register blueprints only if not already registered (defensive, avoids double-registration during tests)
    if auth_bp.name not in app.blueprints:
        app.register_blueprint(auth_bp, url_prefix='/api/auth')
    if user_bp.name not in app.blueprints:
        app.register_blueprint(user_bp, url_prefix='/api/user')
    if official_bp.name not in app.blueprints:
        app.register_blueprint(official_bp, url_prefix='/api/official')
    if admin_bp.name not in app.blueprints:
        app.register_blueprint(admin_bp, url_prefix='/api/admin')
    if complaints_bp.name not in app.blueprints:
        app.register_blueprint(complaints_bp, url_prefix='/api/complaints')
    if ai_bp.name not in app.blueprints:
        app.register_blueprint(ai_bp, url_prefix='/api/ai')
    # Alias required by the external image-validation API contract.
    if 'validate_image_public' not in app.view_functions:
        app.add_url_rule('/validate-image', endpoint='validate_image_public', view_func=validate_image, methods=['POST', 'OPTIONS'])
        app.add_url_rule('/api/validate-image', endpoint='validate_image_api_public', view_func=validate_image, methods=['POST', 'OPTIONS'])
    if emergency_bp.name not in app.blueprints:
        app.register_blueprint(emergency_bp)
    app.logger.info("=== REGISTERED ROUTES ===")
    for rule in app.url_map.iter_rules():
        app.logger.info(
            "ROUTE: %s | METHODS: %s",
            rule.rule,
            sorted(rule.methods)
        )

    @app.route('/api/health')
    def health_check():
        return jsonify({
            'status': 'ok',
            'message': 'Backend running',
            'yolo': yolo_status()
        }), 200
    

    @app.route('/uploads/<path:filename>')
    def upload_file(filename):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    return app


def start_overdue_monitor(app):
    """Run overdue escalation independently of dashboard polling."""
    if app.extensions.get('overdue_monitor_started'):
        return
    app.extensions['overdue_monitor_started'] = True

    def monitor():
        while True:
            socketio.sleep(15)
            try:
                with app.app_context():
                    process_overdue_complaints()
            except Exception:
                app.logger.exception('Overdue complaint monitor failed')
                with app.app_context():
                    db.session.rollback()
            finally:
                with app.app_context():
                    db.session.remove()

    socketio.start_background_task(monitor)


if __name__ == '__main__':
    app = create_app()
    seed_defaults(app)
    start_overdue_monitor(app)
    # Use socketio.run with debug disabled for a stable local backend service.
    socketio.run(
        app,
        host='0.0.0.0',
        port=int(os.environ.get('PORT', '5000')),
        debug=False,
        # Flask-SocketIO 5.3+ requires this explicit opt-in when using
        # Werkzeug for a local development server.
        allow_unsafe_werkzeug=True,
    )
