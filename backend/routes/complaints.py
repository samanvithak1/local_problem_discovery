import os
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity
from werkzeug.utils import secure_filename
from models import db, Complaint, ComplaintStatus, User, Official, Notification, Image, ComplaintHistory, EmergencyAlert, ComplaintCluster, EvidenceValidation, DeadlineExtensionRequest
from utils import make_response_payload, allowed_file, current_identity
from ai_service import analyse_complaint, VALIDATION_CONFIDENCE, LOW_CONFIDENCE_REVIEW_PERCENT, canonical_civic_category
from services.alert_service import dispatch_complaint_alerts, create_history_entry, assign_complaint_to_official, infer_department_for_category, process_overdue_complaints

complaints_bp = Blueprint('complaints_bp', __name__)

SLA_HOURS = {'Critical': 2, 'High': 12, 'Medium': 24, 'Low': 48}

def cluster_complaint(complaint):
    """Link same-category reports within 200m into a case cluster."""
    try:
        latitude, longitude = float(complaint.latitude), float(complaint.longitude)
    except (TypeError, ValueError):
        return None
    # Approximate bounding box is sufficient before calculating exact route map;
    # 0.002 degrees is about 200m at Indian city latitudes.
    nearby = Complaint.query.filter(Complaint.category == complaint.category, Complaint.id != complaint.id,
        Complaint.latitude.isnot(None), Complaint.longitude.isnot(None), Complaint.cluster_id.isnot(None)).all()
    for other in nearby:
        try:
            if ((float(other.latitude) - latitude) ** 2 + (float(other.longitude) - longitude) ** 2) ** .5 <= .002:
                complaint.cluster_id = other.cluster_id
                return other.cluster
        except (TypeError, ValueError):
            continue
    cluster = ComplaintCluster(category=complaint.category, latitude=latitude, longitude=longitude)
    db.session.add(cluster); db.session.flush()
    complaint.cluster_id = cluster.id
    return cluster


def emit_socket_event(event_name, payload):
    try:
        socketio = current_app.extensions.get('socketio')
        if socketio is not None:
            socketio.emit(event_name, payload)
    except Exception as exc:
        current_app.logger.warning('Socket emit failed for %s: %s', event_name, exc)


def ensure_status(name):
    normalized = (name or '').strip()
    if not normalized:
        return None
    status = ComplaintStatus.query.filter_by(name=normalized).first()
    if status is not None:
        return status
    status = ComplaintStatus(name=normalized, description=f'{normalized} status for complaints')
    db.session.add(status)
    db.session.flush()
    return status


def official_can_manage_complaint(official, complaint):
    """Authorise an official for their assigned or department queue.

    Department-less demo/control-room accounts intentionally see the full queue;
    this prevents valid citizen reports being hidden just because older official
    registrations did not store a department.
    """
    if complaint.official_id == official.id:
        return True
    if official.department is None:
        return True
    return official.department.name == infer_department_for_category(complaint.category)


def complaints_visible_to(identity):
    """Return complaints visible to a citizen, official, or administrator."""
    role = identity.get('role')
    if role == 'user':
        return Complaint.query.filter_by(user_id=identity['id']).order_by(
            Complaint.priority_score.desc(), Complaint.created_at.asc()
        ).all()
    if role == 'official':
        official = Official.query.get_or_404(identity['id'])
        return [
            complaint for complaint in Complaint.query.order_by(
                Complaint.priority_score.desc(), Complaint.created_at.asc()
            ).all()
            if official_can_manage_complaint(official, complaint)
        ]
    if role == 'admin':
        return Complaint.query.order_by(
            Complaint.priority_score.desc(), Complaint.created_at.asc()
        ).all()
    return None


@complaints_bp.route('', methods=['GET', 'OPTIONS'])
@complaints_bp.route('/', methods=['GET', 'OPTIONS'])
@jwt_required(optional=True)
def list_complaints():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    if not identity.get('id'):
        return jsonify(make_response_payload('Authentication required')), 401
    if identity.get('role') not in {'user', 'official', 'admin'}:
        return jsonify(make_response_payload('Forbidden')), 403
    process_overdue_complaints()
    complaints = complaints_visible_to(identity)
    return jsonify(make_response_payload('Complaints loaded', {'complaints': [c.to_dict() for c in complaints]})), 200


@complaints_bp.route('/<int:complaint_id>/extension-requests/<int:request_id>', methods=['PUT', 'OPTIONS'])
@jwt_required(optional=True)
def decide_deadline_extension(complaint_id, request_id):
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    if identity.get('role') != 'user' or not identity.get('id'):
        return jsonify(make_response_payload('Only the citizen who filed this complaint can decide the request')), 403
    complaint = Complaint.query.get_or_404(complaint_id)
    if complaint.user_id != identity.get('id'):
        return jsonify(make_response_payload('Only the citizen who filed this complaint can decide the request')), 403
    extension = DeadlineExtensionRequest.query.filter_by(id=request_id, complaint_id=complaint.id).first_or_404()
    if extension.status != 'Pending':
        return jsonify(make_response_payload('This time-extension request has already been decided')), 409
    if complaint.escalated_at or (complaint.status and complaint.status.name in {'Resolved', 'Completed', 'Closed', 'Rejected'}):
        return jsonify(make_response_payload('This case has already been escalated or closed. The administrator must review it')), 409
    decision = str((request.get_json() or {}).get('decision') or '').strip().lower()
    if decision not in {'approve', 'decline'}:
        return jsonify(make_response_payload('decision must be approve or decline')), 400

    now = datetime.utcnow()
    extension.status = 'Approved' if decision == 'approve' else 'Declined'
    extension.decided_at = now
    official = Official.query.get(extension.official_id)
    if decision == 'approve':
        prior_due = complaint.sla_due_at or now
        complaint.sla_due_at = max(prior_due, now) + timedelta(hours=extension.requested_hours)
        if complaint.sla_target_hours is None:
            complaint.sla_target_hours = max(1, round((prior_due - complaint.created_at).total_seconds() / 3600))
        complaint.sla_target_hours += extension.requested_hours
        complaint.reminder_sent_at = None
        decision_message = f'Citizen approved {extension.requested_hours} extra hours for complaint #{complaint.id}.'
        history_note = f'Citizen approved {extension.requested_hours} extra hours. New deadline: {complaint.sla_due_at.isoformat()} UTC.'
    else:
        decision_message = f'Citizen declined the extra-time request for complaint #{complaint.id}.'
        history_note = 'Citizen declined the official’s request for more time.'

    db.session.add(ComplaintHistory(complaint_id=complaint.id,
        status_name=complaint.status.name if complaint.status else 'In Progress', note=history_note))
    db.session.add(Notification(user_id=complaint.user_id, message=decision_message))
    if official:
        db.session.add(Notification(official_id=official.id, message=decision_message))
    db.session.add(Notification(user_id=None, official_id=None,
        message=f'{decision_message} Assigned official: {official.full_name if official else "Unknown"}.'))
    complaint.updated_at = now
    db.session.commit()
    emit_socket_event('complaint.updated', {'complaint': complaint.to_dict()})
    return jsonify(make_response_payload('Time-extension request updated', {
        'request': extension.to_dict(), 'complaint': complaint.to_dict(),
    })), 200

@complaints_bp.route('/create', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def create_complaint():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    if identity.get('role') != 'user' or not identity.get('id'):
        return jsonify(make_response_payload('Only citizens can submit complaints')), 403
    data = request.get_json() or {}
    missing_fields = [field for field in ('title', 'category', 'description', 'location') if not str(data.get(field, '')).strip()]
    if missing_fields:
        return jsonify(make_response_payload(f"Missing required fields: {', '.join(missing_fields)}")), 400
    status = ComplaintStatus.query.filter_by(name='Submitted').first()
    if status is None:
        status = ComplaintStatus(name='Submitted', description='Complaint has been logged and is pending assignment')
        db.session.add(status)
        db.session.commit()
    validation_id = data.get('validation_id')
    validation = EvidenceValidation.query.filter(
        EvidenceValidation.id == validation_id,
        EvidenceValidation.user_id == identity.get('id'),
        EvidenceValidation.validation_status.in_(('valid', 'review_required')),
        EvidenceValidation.complaint_id.is_(None),
    ).first()
    minimum_confidence = VALIDATION_CONFIDENCE * 100
    is_review_required = bool(validation and validation.validation_status == 'review_required')
    same_category = bool(validation and canonical_civic_category(validation.selected_category) == canonical_civic_category(data.get('category')))
    is_zero_shot_match = bool(validation and validation.validation_status == 'valid'
        and 'OpenCLIP' in (validation.model_version or '')
        and canonical_civic_category(validation.detected_category) == canonical_civic_category(data.get('category')))
    ai_confirmed = bool(validation and validation.validation_status == 'valid'
                        and canonical_civic_category(validation.detected_category) == canonical_civic_category(data.get('category'))
                        and float(validation.confidence or 0) >= minimum_confidence)
    if not validation or not same_category or (not is_review_required and not ai_confirmed and not is_zero_shot_match):
        return jsonify(make_response_payload('A matching civic image assessment is required before submission.')), 422
    analysis = analyse_complaint(data.get('description', ''), data.get('category', 'Others'), int(data.get('imageCount', 0)), int(data.get('nearbyReports', 0)))
    complaint = Complaint(
        title=data.get('title', '').strip(),
        category=data.get('category', '').strip(),
        description=data.get('description', '').strip(),
        priority=analysis['priority'],
        priority_score=analysis['severity'],
        location=data.get('location', '').strip(),
        latitude=data.get('latitude'),
        longitude=data.get('longitude'),
        status=status,
        user_id=identity.get('id'),
        official_id=None,
        ai_category=validation.detected_category or validation.candidate_category,
        ai_confidence=float(validation.confidence) if validation.confidence is not None else None,
        sla_target_hours=SLA_HOURS.get(analysis['priority'], 24),
        sla_due_at=datetime.utcnow() + timedelta(hours=SLA_HOURS.get(analysis['priority'], 24)),
    )
    db.session.add(complaint)
    db.session.flush()

    db.session.add(ComplaintHistory(complaint_id=complaint.id, status_name='Submitted', note='Citizen submitted complaint'))
    if is_review_required:
        db.session.add(ComplaintHistory(complaint_id=complaint.id, status_name='Submitted',
            note='Image received; automated category validation was unavailable and official image review is required.'))
    elif is_zero_shot_match:
        db.session.add(ComplaintHistory(complaint_id=complaint.id, status_name='Submitted',
            note=f'Visual AI best match: {validation.detected_category}. Accepted for submission; assigned official must verify the image.'))
    elif validation.confidence is not None and float(validation.confidence) < LOW_CONFIDENCE_REVIEW_PERCENT:
        db.session.add(ComplaintHistory(complaint_id=complaint.id, status_name='Submitted',
            note=f'AI matched {validation.detected_category} at a low {float(validation.confidence):.2f}% score; official should visually verify the evidence.'))
    validation.complaint_id = complaint.id
    if validation.image_path:
        db.session.add(Image(complaint_id=complaint.id, url=validation.image_path, phase='Validated evidence', media_type='image'))
    cluster_complaint(complaint)

    assigned_official = assign_complaint_to_official(complaint)
    if assigned_official is not None:
        db.session.add(ComplaintHistory(
            complaint_id=complaint.id,
            status_name='Submitted',
            note=f'Assigned to {assigned_official.full_name} ({assigned_official.designation}) for review'
        ))

    # Persist notifications for the citizen and the officials control room
    citizen_notice = Notification(
        user_id=identity.get('id'),
        message=f"Complaint '{complaint.title}' submitted successfully",
    )
    db.session.add(citizen_notice)
    if analysis['priority'] in {'Critical', 'High'}:
        db.session.add(Notification(user_id=identity.get('id'), message=f'Emergency alert dispatched for complaint #{complaint.id}. Officials have been notified.'))

    alert_payload = dispatch_complaint_alerts(complaint, analysis)

    db.session.commit()

    payload = {'complaint': complaint.to_dict(), 'analysis': analysis, 'alerts': alert_payload}

    # Emit socket events for real-time clients
    emit_socket_event('complaint.created', payload)
    emit_socket_event('emergency.alert', {'complaintId': complaint.id, 'alert': alert_payload})

    return jsonify(make_response_payload('Complaint submitted', payload)), 201

@complaints_bp.route('/<int:complaint_id>/upload-media', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def upload_media(complaint_id):
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    role = identity.get('role')
    if role not in {'user', 'official'} or not identity.get('id'):
        return jsonify(make_response_payload('Authentication required')), 401
    complaint = Complaint.query.get_or_404(complaint_id)
    if role == 'user':
        if complaint.user_id != identity.get('id'):
            return jsonify(make_response_payload('Unauthorized')), 403
    elif role == 'official':
        official = Official.query.get_or_404(identity.get('id'))
        if not official_can_manage_complaint(official, complaint):
            return jsonify(make_response_payload('Unauthorized')), 403
        complaint.official_id = official.id
    files = request.files.getlist('mediaFile')
    if not files or any(not file or not allowed_file(file.filename) for file in files):
        return jsonify(make_response_payload('Invalid or missing media file')), 400
    upload_dir = current_app.config['UPLOAD_FOLDER']
    urls = []
    for file in files:
        filename = f"{complaint.id}_{int(datetime.utcnow().timestamp() * 1000)}_{secure_filename(file.filename)}"
        destination = os.path.join(upload_dir, filename)
        file.save(destination)
        url = f"/uploads/{filename}"
        media_type = 'video' if file.filename.lower().endswith(('.mp4', '.mov', '.avi', '.mkv', '.webm')) else 'image'
        phase = 'Official progress evidence' if role == 'official' else 'Citizen complaint evidence'
        db.session.add(Image(complaint_id=complaint.id, url=url, phase=phase, media_type=media_type))
        urls.append(url)
    db.session.commit()

    # Emit event after media uploaded so UI can show thumbnails immediately
    emit_socket_event('complaint.updated', {'complaintId': complaint.id, 'imageUrls': urls})

    return jsonify(make_response_payload('Complaint media uploaded', {'imageUrls': urls})), 201


@complaints_bp.route('/<int:complaint_id>', methods=['DELETE', 'OPTIONS'])
@jwt_required(optional=True)
def delete_complaint(complaint_id):
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    role = identity.get('role')
    if not identity.get('id'):
        return jsonify(make_response_payload('Authentication required')), 401
    if role == 'user':
        complaint = Complaint.query.filter_by(id=complaint_id, user_id=identity['id']).first_or_404()
    elif role == 'official':
        official = Official.query.get_or_404(identity['id'])
        complaint = Complaint.query.get_or_404(complaint_id)
        if not official_can_manage_complaint(official, complaint):
            return jsonify(make_response_payload('Unauthorized')), 403
    else:
        return jsonify(make_response_payload('Forbidden')), 403
    status_name = (complaint.status.name if complaint.status else '').strip().lower()
    if status_name not in {'submitted', 'accepted', 'completed', 'resolved'}:
        return jsonify(make_response_payload('Only submitted, accepted, or completed complaints can be deleted')), 400

    images = list(complaint.completion_images)
    image_files = [image.url for image in images if image.url.startswith('/uploads/')]
    history_entries = list(complaint.history_entries)
    for image in images:
        db.session.delete(image)
    for entry in history_entries:
        db.session.delete(entry)
    EmergencyAlert.query.filter_by(complaint_id=complaint.id).delete(synchronize_session=False)
    db.session.flush()
    db.session.delete(complaint)
    db.session.commit()

    for image_url in image_files:
        file_path = os.path.join(current_app.config['UPLOAD_FOLDER'], os.path.basename(image_url))
        try:
            if os.path.isfile(file_path):
                os.remove(file_path)
        except OSError:
            current_app.logger.warning('Could not remove upload %s', file_path)

    emit_socket_event('complaint.deleted', {'complaintId': complaint_id})
    return jsonify(make_response_payload('Complaint deleted')), 200

@complaints_bp.route('/<int:complaint_id>/update', methods=['PUT', 'OPTIONS'])
@jwt_required(optional=True)
def update_complaint(complaint_id):
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    role = identity.get('role')
    if not identity.get('id'):
        return jsonify(make_response_payload('Authentication required')), 401
    if role not in {'user', 'official'}:
        return jsonify(make_response_payload('Forbidden')), 403
    data = request.get_json() or {}
    complaint = Complaint.query.get_or_404(complaint_id)
    if role == 'user' and complaint.user_id != identity.get('id'):
        return jsonify(make_response_payload('Unauthorized')), 403
    if role == 'official':
        official = Official.query.get_or_404(identity.get('id'))
        if not official_can_manage_complaint(official, complaint):
            return jsonify(make_response_payload('Unauthorized')), 403
        # The first official to take an action claims the shared queue item.
        complaint.official_id = official.id
    if role == 'official':
        action = (data.get('action') or '').strip().lower()
        status_name = None
        if action in {'accept', 'accepted'}:
            status_name = 'Accepted'
            complaint.remarks = data.get('remarks') or 'Complaint accepted by official.'
        elif action in {'reject', 'rejected'}:
            status_name = 'Rejected'
            complaint.remarks = data.get('remarks') or 'Complaint rejected by official.'
        elif action in {'complete', 'completed', 'resolve', 'resolved'}:
            status_name = 'Resolved'
            complaint.remarks = data.get('remarks') or 'Complaint completed by official.'
        elif action in {'progress', 'in_progress', 'start', 'working'}:
            status_name = 'In Progress'
            complaint.remarks = data.get('remarks') or 'Complaint is being worked on.'
        else:
            status_id = data.get('statusId')
            if status_id is not None:
                complaint.status_id = int(status_id)
            status_name = data.get('statusName') or (complaint.status.name if complaint.status else None)
            if status_name:
                complaint.status = ensure_status(status_name)
                complaint.status_id = complaint.status.id
            complaint.remarks = data.get('remarks', complaint.remarks)

        if status_name:
            complaint.status = ensure_status(status_name)
            complaint.status_id = complaint.status.id

        for image_url in data.get('completionImages', []) or []:
            if image_url:
                db.session.add(Image(complaint_id=complaint.id, url=image_url, phase=status_name or complaint.status.name))

    complaint.updated_at = datetime.utcnow()
    status_name = complaint.status.name if complaint.status else 'Updated'
    if data.get('statusName'):
        status_name = data.get('statusName')
    db.session.add(ComplaintHistory(complaint_id=complaint.id, status_name=status_name, note=data.get('remarks') or 'Complaint updated'))
    if complaint.status and complaint.status.name == 'Resolved' and complaint.cluster_id:
        resolved = ensure_status('Resolved')
        for linked in Complaint.query.filter(Complaint.cluster_id == complaint.cluster_id, Complaint.id != complaint.id).all():
            if linked.status and linked.status.name != 'Resolved':
                linked.status_id = resolved.id
                linked.remarks = f'Resolved with cluster #{complaint.cluster_id}: {complaint.remarks or "field work completed"}'
                db.session.add(ComplaintHistory(complaint_id=linked.id, status_name='Resolved', note=f'Automatically resolved with cluster #{complaint.cluster_id}'))
    db.session.commit()

    # Emit complaint.updated for real-time updates
    emit_socket_event('complaint.updated', {'complaint': complaint.to_dict()})

    return jsonify(make_response_payload('Complaint updated', {'complaint': complaint.to_dict()})), 200


@complaints_bp.route('/<int:complaint_id>/progress', methods=['POST', 'OPTIONS'])
@jwt_required(optional=True)
def update_complaint_progress(complaint_id):
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    if identity.get('role') != 'official':
        return jsonify(make_response_payload('Only officials can update complaint progress')), 403
    complaint = Complaint.query.get_or_404(complaint_id)
    official = Official.query.get_or_404(identity.get('id'))
    if not official_can_manage_complaint(official, complaint):
        return jsonify(make_response_payload('Unauthorized')), 403
    complaint.official_id = official.id

    data = request.form.to_dict() if request.form else (request.get_json() or {})
    status_name = data.get('statusName') or 'In Progress'
    complaint.status = ensure_status(status_name)
    complaint.status_id = complaint.status.id
    complaint.remarks = data.get('remarks') or complaint.remarks or 'Complaint update recorded by official.'

    upload_dir = current_app.config['UPLOAD_FOLDER']
    for file in request.files.getlist('mediaFile') + request.files.getlist('completionFiles'):
        if file and file.filename and allowed_file(file.filename):
            filename = f"{complaint.id}_{int(datetime.utcnow().timestamp() * 1000)}_{secure_filename(file.filename)}"
            destination = os.path.join(upload_dir, filename)
            file.save(destination)
            media_type = 'video' if file.filename.lower().endswith(('.mp4', '.mov', '.avi', '.mkv', '.webm')) else 'image'
            db.session.add(Image(complaint_id=complaint.id, url=f'/uploads/{filename}', phase=status_name, media_type=media_type))

    for image_url in data.get('completionImages', []) or []:
        if image_url:
            db.session.add(Image(complaint_id=complaint.id, url=image_url, phase=status_name))

    complaint.updated_at = datetime.utcnow()
    db.session.add(ComplaintHistory(complaint_id=complaint.id, status_name=complaint.status.name, note=complaint.remarks))
    db.session.commit()

    emit_socket_event('complaint.updated', {'complaint': complaint.to_dict()})

    return jsonify(make_response_payload('Complaint progress updated', {'complaint': complaint.to_dict()})), 200

@complaints_bp.route('/stats', methods=['GET', 'OPTIONS'])
@jwt_required(optional=True)
def complaint_stats():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    if not identity.get('id'):
        return jsonify(make_response_payload('Authentication required')), 401
    complaints = complaints_visible_to(identity)
    if complaints is None:
        return jsonify(make_response_payload('Forbidden')), 403
    total = len(complaints)
    submitted = sum(1 for complaint in complaints if complaint.status and complaint.status.name == 'Submitted')
    in_progress = sum(1 for complaint in complaints if complaint.status and complaint.status.name == 'In Progress')
    resolved = sum(1 for complaint in complaints if complaint.status and complaint.status.name == 'Resolved')
    return jsonify(make_response_payload('Complaint analytics', {
        'summary': {
            'totalComplaints': total,
            'submitted': submitted,
            'inProgress': in_progress,
            'resolved': resolved,
        }
    })), 200

@complaints_bp.route('/nearby', methods=['GET', 'OPTIONS'])
@jwt_required(optional=True)
def nearby_complaints():
    if request.method == 'OPTIONS':
        return jsonify(make_response_payload('Preflight OK', {})), 200
    identity = current_identity()
    if not identity.get('id'):
        return jsonify(make_response_payload('Authentication required')), 401
    complaints = complaints_visible_to(identity)
    if complaints is None:
        return jsonify(make_response_payload('Forbidden')), 403
    try:
        latitude, longitude = float(request.args['latitude']), float(request.args['longitude'])
    except (KeyError, TypeError, ValueError):
        return jsonify(make_response_payload('latitude and longitude are required')), 400
    try:
        radius = min(max(float(request.args.get('radius', 5)), .1), 20)
    except (TypeError, ValueError):
        return jsonify(make_response_payload('radius must be a number')), 400
    items = []
    for complaint in complaints:
        if complaint.latitude is None or complaint.longitude is None:
            continue
        try:
            distance = (((float(complaint.latitude)-latitude) ** 2 + (float(complaint.longitude)-longitude) ** 2) ** .5) * 111
        except (TypeError, ValueError):
            continue
        if distance <= radius:
            items.append({
                'id': complaint.id,
                'category': complaint.category,
                'priority': complaint.priority,
                'status': complaint.status.name if complaint.status else None,
                'latitude': complaint.latitude,
                'longitude': complaint.longitude,
                'created_at': complaint.created_at.isoformat() + 'Z',
                'distance_km': round(distance, 2),
            })
    return jsonify(make_response_payload('Nearby complaints loaded', {'complaints': sorted(items, key=lambda item: item['distance_km'])})), 200
