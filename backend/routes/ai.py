import os
import csv
import io
import hashlib
import shutil
import sys
import threading
from tempfile import NamedTemporaryFile
from datetime import datetime
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required
from werkzeug.utils import secure_filename
from ai_service import analyse_complaint, validate_civic_media, validate_civic_image, classify_civic_image_zero_shot, canonical_civic_category, yolo_status, CATEGORY_TERMS, DATASET_ROOT, COMPLAINT_DATASET_DIR, VALID_PRIORITIES, LOW_CONFIDENCE_REVIEW_PERCENT, dataset_summary, dataset_health, complaint_dataset_summary, clear_text_model_cache
from models import db, EvidenceValidation
from utils import make_response_payload, allowed_file, current_identity

ai_bp = Blueprint('ai', __name__)

# YOLO training can take hours.  Keep it outside the request lifecycle and
# expose a small, pollable status object for the dashboard.
_yolo_training = {'state': 'idle', 'started_at': None, 'finished_at': None,
                  'returncode': None, 'output': '', 'error': None}
_yolo_training_lock = threading.Lock()

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.webp', '.bmp', '.dib', '.tif', '.tiff', '.gif', '.avif', '.jp2', '.j2k', '.ico', '.tga'}
PIL_IMAGE_FORMATS = {'JPEG', 'PNG', 'WEBP', 'BMP', 'DIB', 'TIFF', 'GIF', 'AVIF', 'JPEG2000', 'ICO', 'TGA'}

@ai_bp.route('/validate-image', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def validate_image():
    """Production image gate: validate, audit, and issue a one-use validation id."""
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'}), 200
    if current_identity().get('role') != 'user':
        return jsonify({'status': 'invalid', 'message': 'Only citizens can validate complaint images.'}), 403
    selected = (request.form.get('selected_category') or request.form.get('category') or '').strip()
    upload = request.files.get('image') or request.files.get('file')
    if canonical_civic_category(selected) is None:
        return jsonify({'status': 'invalid', 'message': f'Unsupported civic category: {selected or "(empty)"}.'}), 400
    if not upload or not upload.filename:
        return jsonify({'status': 'invalid', 'message': 'Choose an image file to validate.'}), 400
    manual_review_reason = None
    
    suffix = os.path.splitext(upload.filename)[1].lower()
    if suffix not in IMAGE_EXTENSIONS:
        return jsonify({'status': 'invalid', 'message': 'Unsupported image format. Use JPG, PNG, WebP, BMP, TIFF, GIF, AVIF, or JPEG 2000.'}), 400
    temp_path = None
    try:
        raw = upload.read()
        if not raw:
            return jsonify({'status': 'invalid', 'message': 'Empty uploads are not allowed.'}), 400
        max_size = current_app.config.get('MAX_CONTENT_LENGTH')
        if max_size and len(raw) > max_size:
            return jsonify({'status': 'invalid', 'message': 'Image exceeds the maximum allowed size.'}), 413
        content_hash = hashlib.sha256(raw).hexdigest()
        prior_audit = EvidenceValidation.query.filter_by(content_sha256=content_hash).first()
        if prior_audit and (prior_audit.user_id != current_identity().get('id') or prior_audit.complaint_id is not None):
            # Keep the prior complaint protected from duplicate submission, but
            # show the user the existing AI assessment instead of presenting a
            # previously reviewed photo as an invalid image.
            candidate = prior_audit.candidate_category
            candidate_source = 'zero_shot' if candidate and 'OpenCLIP' in (prior_audit.model_version or '') else None
            prediction_time_ms = None

            linked_complaint = f'complaint #{prior_audit.complaint_id}' if prior_audit.complaint_id else 'another account'
            message = f'This image is already attached to {linked_complaint} and cannot be submitted again.'
            if candidate:
                message += f' Visual AI candidate: {candidate}; official confirmation is still required.'
            return jsonify({
                'status': 'duplicate', 'duplicate': True,
                'selected_category': canonical_civic_category(selected),
                'detected_category': prior_audit.detected_category,
                'candidate_category': candidate,
                'candidate_source': candidate_source,
                'candidate_confidence': None,
                'confidence': prior_audit.confidence,
                'prediction_time_ms': prediction_time_ms,
                'message': message,
            }), 200
        # Decode and normalize supported formats before inference; YOLO receives
        # RGB JPEG regardless of the citizen's source image format.
        try:
            from PIL import Image as PILImage
            from PIL import ImageOps
            with PILImage.open(io.BytesIO(raw)) as image:
                if image.format not in PIL_IMAGE_FORMATS:
                    raise ValueError('Unsupported image format')
                image.verify()
            with PILImage.open(io.BytesIO(raw)) as image:
                if image.width * image.height > 40_000_000:
                    return jsonify({'status': 'invalid', 'message': 'Image dimensions are too large. Use an image under 40 megapixels.'}), 413
                image.seek(0)  # For animated formats, validate the first frame.
                normalized = ImageOps.exif_transpose(image).convert('RGB')
        except Exception:
            return jsonify({'status': 'invalid', 'message': 'Could not decode this image. Use a valid JPG, PNG, WebP, BMP, TIFF, GIF, AVIF, or JPEG 2000 image.'}), 400
        with NamedTemporaryFile(delete=False, suffix='.jpg') as temp:
            normalized.save(temp, format='JPEG', quality=95, optimize=True)
            temp_path = temp.name
         
       
        manual_review_reason = (
            'The image file is readable, but automatic AI detection is '
            'temporarily unavailable. The image can be submitted for official review.'
        )

        result = {
            'valid': False,
            'status': 'review_required',
            'selected_category': canonical_civic_category(selected),
            'detected_category': None,
            'confidence': None,
            'message': manual_review_reason,
            'model_version': None,
            'detections': [],
        }

        if result.get('inference_error'):
            current_app.logger.error('YOLOv8 inference failed during image validation: %s', result['message'])
            manual_review_reason = 'The AI could not finish checking this image. It can still be submitted for official image review.'
        elif not manual_review_reason and not result.get('valid'):
            # A trained detector can miss valid civic photos that differ from
            # its training examples. Preserve the photo for a human official to
            # assess instead of rejecting it or claiming an unverified class.
            manual_review_reason = 'The AI could not confirm this category from the image. It can still be submitted for official image review.'
        elif (not manual_review_reason and result.get('confidence') is not None
              and result.get('confidence') < LOW_CONFIDENCE_REVIEW_PERCENT):
            manual_review_reason = 'The image received a low AI match score. It can be submitted for official image review.'
        if manual_review_reason:
          result = {
            'valid': False,
            'status': 'review_required',
            'selected_category': canonical_civic_category(selected),
            'detected_category': None,
            'candidate_category': None,
            'candidate_confidence': None,
            'candidate_similarity': None,
            'candidate_margin': None,
            'candidate_source': None,
            'confidence': None,
            'message': manual_review_reason,
            'model_version': result.get('model_version'),
            'prediction_time_ms': result.get('prediction_time_ms'),
            'detections': [],
            'annotated_png': None,
        }

        validation_status = 'review_required' if manual_review_reason else 'valid'
        if prior_audit:
            # Permit the same citizen to re-run an unsubmitted review photo
            # after model/threshold changes; keep the prior decision in the
            # message so the audit still records the revalidation.
            prior_message = prior_audit.message
            audit = prior_audit
            audit.selected_category = canonical_civic_category(selected)
            audit.detected_category = result.get('detected_category')
            audit.candidate_category = result.get('candidate_category')
            audit.confidence = result.get('confidence')
            audit.validation_status = validation_status
            # A previous category/model run may have stored a YOLO preview.
            # Never attach that old annotation to this new validation result.
            audit.preview_path = None
            audit.message = f'Revalidated. Previous result: {prior_message[:180]} Current result: {result.get("message", "Image validated successfully.")}'[:512]
            audit.model_version = result.get('model_version')
            audit.predicted_at = datetime.utcnow()
        else:
            audit = EvidenceValidation(user_id=current_identity().get('id'), selected_category=canonical_civic_category(selected), detected_category=result.get('detected_category'),
                candidate_category=result.get('candidate_category'), confidence=result.get('confidence'), content_sha256=content_hash, validation_status=validation_status,
                message=result.get('message', 'Image validated successfully.'), model_version=result.get('model_version'))
        if validation_status in {'valid', 'review_required'}:
            validation_dir = os.path.join(current_app.config['UPLOAD_FOLDER'], 'validations')
            os.makedirs(validation_dir, exist_ok=True)
            # The stored evidence bytes are the normalized JPEG above, so the
            # public filename must describe those bytes rather than the upload's
            # original format (which may have been TIFF, AVIF, or GIF).
            image_name = f'{content_hash}.jpg'
            image_path = os.path.join(validation_dir, image_name)
            shutil.copyfile(temp_path, image_path)
            audit.image_path = f'/uploads/validations/{image_name}'
            annotated = result.pop('annotated_png', None)
            if annotated:
                preview_name = f'{content_hash}_bbox.png'
                with open(os.path.join(validation_dir, preview_name), 'wb') as preview:
                    preview.write(annotated)
                audit.preview_path = f'/uploads/validations/{preview_name}'
        db.session.add(audit); db.session.commit()
        response = {key: value for key, value in result.items() if key not in {'valid', 'annotated_png'}}
        response.update({'validation_id': audit.id, 'image_path': audit.image_path, 'bounding_box_image': audit.preview_path,
                         'bounding_boxes': result.get('detections', [])})
        return jsonify(response), 200
    finally:
        if temp_path:
            try: os.remove(temp_path)
            except OSError: pass

@ai_bp.route('/validate-evidence', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def validate_evidence():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    if current_identity().get('role') != 'user':
        return jsonify(make_response_payload('Only citizens can validate complaint evidence')), 403
    selected_category = (request.form.get('category') or '').strip()
    evidence = request.files.get('file')
    if selected_category not in CATEGORY_TERMS or not evidence or not evidence.filename:
        return jsonify(make_response_payload('Select a supported category and upload an image or video')), 400
    result = validate_civic_media(evidence, selected_category)
    status = 200 if result.get('valid') else (503 if 'not deployed' in result.get('reason', '') else 422)
    return jsonify(make_response_payload('Evidence validation complete' if result.get('valid') else result.get('reason'), {'validation': result})), status

@ai_bp.route('/analyze', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def analyze():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    data = request.get_json() or {}
    result = analyse_complaint(data.get('text', ''), data.get('category', 'Others'), int(data.get('imageCount', 0)), int(data.get('nearbyReports', 0)))
    return jsonify(make_response_payload('AI analysis complete', {'analysis': result})), 200

@ai_bp.route('/training/metrics', methods=['GET', 'OPTIONS'])
@jwt_required(optional=True)
def training_metrics():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    if current_identity().get('role') != 'admin':
        return jsonify(make_response_payload('Forbidden')), 403
    metrics_path = os.path.join(os.path.dirname(DATASET_ROOT), 'trained_models', 'metrics.json')
    text_metrics_path = os.path.join(os.path.dirname(DATASET_ROOT), 'trained_models', 'complaint_text_model.json')
    trained = {}
    if os.path.exists(metrics_path):
        import json
        with open(metrics_path, encoding='utf-8') as metrics_file:
            trained = json.load(metrics_file)
    text_trained = {}
    if os.path.exists(text_metrics_path):
        import json
        with open(text_metrics_path, encoding='utf-8') as f:
            text_trained = json.load(f)

    # Never manufacture model performance: the dashboard stays empty until a
    # real training run has persisted metrics.
    accuracy = trained.get('test', {}).get('accuracy') or text_trained.get('category_accuracy')
    val_accuracy = trained.get('validation', {}).get('accuracy') or text_trained.get('priority_accuracy')
    precision = trained.get('test', {}).get('precision') or text_trained.get('precision')
    recall = trained.get('test', {}).get('recall') or text_trained.get('recall')
    f1 = trained.get('test', {}).get('f1') or text_trained.get('f1')

    detector_model = yolo_status()
    status = 'Model Trained & Operational' if (os.path.exists(metrics_path) or os.path.exists(text_metrics_path)) else 'Ready for dataset upload'

    complaint_dataset = complaint_dataset_summary()
    return jsonify(make_response_payload('Training metrics loaded', {'metrics': {
        'status': status,
        'accuracy': float(accuracy) if accuracy is not None else None,
        'validationAccuracy': float(val_accuracy) if val_accuracy is not None else None,
        'precision': float(precision) if precision is not None else None,
        'recall': float(recall) if recall is not None else None,
        'f1': float(f1) if f1 is not None else None,
        'sampleCount': complaint_dataset['sampleCount'] or text_trained.get('sample_count', 0),
        'classes': list(CATEGORY_TERMS.keys()),
        'dataset': dataset_summary(),
        'datasetHealth': dataset_health(),
        'complaintDataset': complaint_dataset,
        'trained': trained,
        'textTrained': text_trained,
        'detector': detector_model,
        'detectorTraining': dict(_yolo_training),
    }})), 200


@ai_bp.route('/training/train', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def run_training():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    if current_identity().get('role') != 'admin':
        return jsonify(make_response_payload('Forbidden')), 403
    import subprocess
    import sys
    script = os.path.join(os.path.dirname(DATASET_ROOT), 'scripts', 'train_text_classifier.py')
    result = subprocess.run([sys.executable, script], capture_output=True, text=True)
    if result.returncode == 0:
        clear_text_model_cache()
        return jsonify(make_response_payload('Model training finished', {'output': result.stdout})), 200
    return jsonify(make_response_payload('Training failed', {'error': result.stderr})), 500


@ai_bp.route('/training/yolo', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def run_yolo_training():
    """Start a real labelled-image training run without blocking Flask."""
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    if current_identity().get('role') != 'admin':
        return jsonify(make_response_payload('Forbidden')), 403

    payload = request.get_json(silent=True) or {}
    epochs = payload.get('epochs', 100)
    try:
        epochs = int(epochs)
        if not 1 <= epochs <= 500:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify(make_response_payload('epochs must be between 1 and 500')), 400

    with _yolo_training_lock:
        if _yolo_training['state'] == 'running':
            return jsonify(make_response_payload('YOLO training is already running', {'training': dict(_yolo_training)})), 409
        _yolo_training.update({'state': 'running', 'started_at': datetime.utcnow().isoformat() + 'Z',
                               'finished_at': None, 'returncode': None, 'output': '', 'error': None})

    script = os.path.join(os.path.dirname(DATASET_ROOT), 'scripts', 'train_yolo_civic.py')
    def train():
        completed = subprocess.run([sys.executable, script, '--epochs', str(epochs)],
                                   cwd=os.path.dirname(DATASET_ROOT), capture_output=True, text=True)
        output = (completed.stdout + '\n' + completed.stderr)[-12000:]
        with _yolo_training_lock:
            _yolo_training.update({'state': 'completed' if completed.returncode == 0 else 'failed',
                                   'finished_at': datetime.utcnow().isoformat() + 'Z',
                                   'returncode': completed.returncode, 'output': output,
                                   'error': None if completed.returncode == 0 else output})
        if completed.returncode == 0:
            # The new checkpoint is loaded lazily after its atomic deployment.
            import ai_service
            ai_service._YOLO_MODEL = None
            ai_service._YOLO_LOAD_ATTEMPTED = False

    threading.Thread(target=train, daemon=True, name='civic-yolo-training').start()
    return jsonify(make_response_payload('YOLO training started. The existing detector stays active until the new best.pt passes evaluation.',
                                         {'training': dict(_yolo_training)})), 202


@ai_bp.route('/training/dataset', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def upload_dataset():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    if current_identity().get('role') != 'admin':
        return jsonify(make_response_payload('Forbidden')), 403
    category = (request.form.get('category') or '').strip()
    if category not in CATEGORY_TERMS:
        return jsonify(make_response_payload('Choose a valid civic-problem category')), 400
    files = request.files.getlist('files')
    if not files or any(not allowed_file(file.filename) or os.path.splitext(file.filename)[1].lower() not in IMAGE_EXTENSIONS for file in files):
        return jsonify(make_response_payload('Upload one or more supported image files (JPG, PNG, WebP, BMP, TIFF, GIF, AVIF, or JPEG 2000)')), 400
    folder = os.path.join(DATASET_ROOT, category.replace(' ', '_'))
    os.makedirs(folder, exist_ok=True)
    saved = 0
    for file in files:
        filename = f"{int(datetime.utcnow().timestamp() * 1000)}_{secure_filename(file.filename)}"
        file.save(os.path.join(folder, filename)); saved += 1
    return jsonify(make_response_payload('Dataset images uploaded', {'saved': saved, 'dataset': dataset_summary()})), 201


@ai_bp.route('/training/complaint-dataset', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def upload_complaint_dataset():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    """Validate and add labelled CSV rows used by the text classifier."""
    if current_identity().get('role') != 'admin':
        return jsonify(make_response_payload('Forbidden')), 403
    upload = request.files.get('file')
    if not upload or not upload.filename.lower().endswith('.csv'):
        return jsonify(make_response_payload('Upload a CSV file with complaint_text, category, and priority columns')), 400
    try:
        rows = list(csv.DictReader(io.StringIO(upload.read().decode('utf-8-sig'))))
    except (UnicodeDecodeError, csv.Error):
        return jsonify(make_response_payload('The complaint dataset must be a valid UTF-8 CSV file')), 400
    required = {'complaint_text', 'category', 'priority'}
    if not rows or not required.issubset(set(rows[0] or {})):
        return jsonify(make_response_payload('CSV headers must include complaint_text, category, and priority')), 400

    validated = []
    for row in rows:
        text = (row.get('complaint_text') or '').strip()
        category = (row.get('category') or '').strip()
        priority = (row.get('priority') or '').strip().capitalize()
        if text and category in CATEGORY_TERMS and priority in VALID_PRIORITIES:
            validated.append({'complaint_text': text, 'category': category, 'priority': priority})
    if not validated:
        return jsonify(make_response_payload('No valid rows found. Use supported categories and Critical, High, Medium, or Low priorities')), 400

    COMPLAINT_DATASET_DIR.mkdir(parents=True, exist_ok=True)
    filename = COMPLAINT_DATASET_DIR / f'uploaded_complaints_{int(datetime.utcnow().timestamp() * 1000)}.csv'
    with filename.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['complaint_text', 'category', 'priority'])
        writer.writeheader()
        writer.writerows(validated)
    clear_text_model_cache()
    return jsonify(make_response_payload('Complaint dataset added. Train the model to use the new records.', {
        'saved': len(validated), 'complaintDataset': complaint_dataset_summary(),
    })), 201
