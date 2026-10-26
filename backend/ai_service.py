"""Lightweight, deterministic AI fallback used when a trained model is unavailable.

The interface is deliberately model-agnostic: replace ``analyse_complaint`` with
YOLO/EfficientNet and BERT inference once trained model artefacts are deployed.
"""
from collections import Counter
import csv
import json
import logging
import os
import threading
import time
from pathlib import Path
from tempfile import NamedTemporaryFile

# Keep Ultralytics runtime state inside the application rather than a user
# profile, which is frequently unavailable to a service account.
CONFIG_DIR = Path(__file__).resolve().parent / '.ultralytics'
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
os.environ['YOLO_CONFIG_DIR'] = str(CONFIG_DIR)
os.environ['MPLCONFIGDIR'] = str(CONFIG_DIR / 'matplotlib')
VISION_CACHE_DIR = Path(__file__).resolve().parent / 'models' / '.hf-cache'
VISION_CACHE_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault('HF_HOME', str(VISION_CACHE_DIR))

CATEGORY_TERMS = {
    'Road Damage': ('pothole', 'road', 'crack', 'asphalt'),
    'Garbage': ('garbage', 'waste', 'trash', 'dump'),
    'Street Light': ('street light', 'streetlight', 'lamp', 'dark'),
    'Water Leakage': ('leak', 'water', 'pipe', 'sewage'),
    'Drainage': ('drain', 'drainage', 'blocked', 'gutter'),
    'Electricity': ('electric', 'wire', 'power', 'transformer'),
    'Tree Fallen': ('tree', 'fallen branch', 'branch'),
    'Flood': ('flood', 'waterlogged', 'inundat'),
    'Fire': ('fire', 'burning', 'blaze', 'smoke', 'flames', 'fire hazard'),
    'Medical Emergency': ('medical emergency', 'ambulance', 'injured', 'unconscious', 'heart attack'),
    'Animal Issue': ('animal', 'stray dog', 'injured animal', 'snake', 'cattle'),
    'Public Property Damage': ('public property', 'vandalism', 'damaged bench', 'damaged sign', 'broken public'),
    'Illegal Dumping': ('illegal dump', 'dumping', 'debris', 'waste'),
    'Traffic Signal': ('traffic signal', 'signal', 'junction', 'traffic'),
}

CATEGORY_ALIASES = {
    'road_damage': 'Road Damage',
    'garbage': 'Garbage',
    'street_light': 'Street Light',
    'water_leakage': 'Water Leakage',
    'drainage': 'Drainage',
    'electricity': 'Electricity',
    'tree_fallen': 'Tree Fallen',
    'flood': 'Flood',
    'fire': 'Fire',
    'medical_emergency': 'Medical Emergency',
    'animal_issue': 'Animal Issue',
    'public_property_damage': 'Public Property Damage',
    'illegal_dumping': 'Illegal Dumping',
    'traffic_signal': 'Traffic Signal',
}

MODEL_DIR = Path(__file__).resolve().parent / 'trained_models'
TEXT_MODEL_PATH = MODEL_DIR / 'complaint_text_model.joblib'
DATASET_ROOT = Path(__file__).resolve().parent / 'datasets'
PRIORITY_RULES_PATH = DATASET_ROOT / 'priority' / 'india_priority_rules.json'
LEGACY_PRIORITY_RULES_PATH = DATASET_ROOT / 'priority_rules.json'
COMPLAINT_DATASET_DIR = DATASET_ROOT / 'complaints'
LEGACY_COMPLAINT_DATASET_DIR = DATASET_ROOT / 'processed' / 'text' / 'complaints'
_TEXT_MODEL = None
_TEXT_MODEL_MTIME_NS = None
VALID_PRIORITIES = ('Critical', 'High', 'Medium', 'Low')
YOLO_MODEL_CANDIDATES = [
    Path(os.environ['YOLO_MODEL_PATH']) if os.environ.get('YOLO_MODEL_PATH') else None,
    Path(__file__).resolve().parent / 'models' / 'best.pt',
]
YOLO_LABELS = {
    'road damage': 'Road Damage', 'pothole': 'Road Damage', 'garbage overflow': 'Garbage', 'garbage': 'Garbage',
    'water leakage': 'Water Leakage', 'water leak': 'Water Leakage', 'drainage blockage': 'Drainage', 'drainage': 'Drainage',
    'streetlight damage': 'Street Light', 'street light': 'Street Light', 'broken street light': 'Street Light',
    'broken streetlight': 'Street Light', 'fallen tree': 'Tree Fallen', 'electric pole damage': 'Electricity',
    'electric pole': 'Electricity', 'illegal dumping': 'Illegal Dumping', 'flood': 'Flood'
}
_YOLO_MODEL = None
_YOLO_LOAD_ATTEMPTED = False
_YOLO_MODEL_MTIME_NS = None
_YOLO_ATTEMPTED_PATH = None
_YOLO_ATTEMPTED_MTIME_NS = None
_YOLO_STATUS = {'ready': False, 'path': None, 'model_version': None, 'error': 'Model has not been initialised.'}
LOGGER = logging.getLogger(__name__)
# Ask YOLO to return weak candidates and allow low-scoring matching detections
# to be filed. These scores are not calibrated accuracy guarantees; very weak
# matches are flagged for official visual review below.
YOLO_PREDICTION_CONFIDENCE = 0.01
VALIDATION_CONFIDENCE = 0.04
# Keep low-scoring detections submittable, but route them for human review.
# YOLO scores here are not calibrated probabilities.
LOW_CONFIDENCE_REVIEW_PERCENT = 20.0

_CLIP_MODEL = None
_CLIP_PREPROCESS = None
_CLIP_TOKENIZER = None
_CLIP_TEXT_FEATURES = None
_CLIP_MODEL_VERSION = 'OpenCLIP ViT-B-32 laion2b_s34b_b79k'
_CLIP_LOCK = threading.Lock()
CLIP_CATEGORY_PROMPTS = {
    'Road Damage': 'a damaged road with potholes, cracks, or broken asphalt',
    'Garbage': 'overflowing street garbage or a pile of litter in a public place',
    'Street Light': 'a broken or damaged street light on a road',
    'Water Leakage': 'water leaking from a broken pipe or public water line',
    'Drainage': 'a blocked or overflowing storm drain or public sewer',
    'Electricity': 'damaged electrical wires, a broken utility pole, or exposed power equipment',
    'Tree Fallen': 'a fallen tree or large branch blocking a road or public area',
    'Illegal Dumping': 'a pile of waste illegally dumped in a public or roadside area',
    'Flood': 'flood water covering a street, building, or public area',
    'Fire': 'an active fire with visible flames or smoke burning a building or public area',
    'Traffic Signal': 'a broken or damaged traffic light or traffic signal at an intersection',
    'Public Property Damage': 'vandalized or damaged public property such as a bench, sign, or shelter',
    'Animal Issue': 'an injured or stray animal causing a public safety problem',
    'Medical Emergency': 'a person experiencing a medical emergency in a public place',
}


def _normalise_yolo_label(label):
    value = str(label or '').strip().lower().replace('_', ' ').replace('-', ' ')
    return YOLO_LABELS.get(value)


def canonical_civic_category(value):
    """Map UI names and trained class labels to the application's categories."""
    normalized = str(value or '').strip().lower().replace('_', ' ').replace('-', ' ')
    aliases = {
        'road damage': 'Road Damage', 'garbage': 'Garbage', 'garbage overflow': 'Garbage',
        'water leakage': 'Water Leakage', 'drainage': 'Drainage', 'drainage blockage': 'Drainage',
        'street light': 'Street Light', 'streetlight': 'Street Light', 'broken street light': 'Street Light',
        'tree fallen': 'Tree Fallen', 'fallen tree': 'Tree Fallen', 'electricity': 'Electricity',
        'flood': 'Flood', 'fire': 'Fire', 'medical emergency': 'Medical Emergency',
        'animal issue': 'Animal Issue', 'public property damage': 'Public Property Damage',
        'traffic signal': 'Traffic Signal',
        'electric pole damage': 'Electricity', 'illegal dumping': 'Illegal Dumping'
    }
    return aliases.get(normalized) or _normalise_yolo_label(normalized)


def load_yolo_model():
    """Load only an explicitly deployed civic YOLOv8 checkpoint.

    COCO weights are intentionally not used: they cannot validate civic issue
    classes and would allow unrelated objects through the submission workflow.
    """
    global _YOLO_MODEL, _YOLO_LOAD_ATTEMPTED, _YOLO_STATUS, _YOLO_MODEL_MTIME_NS
    global _YOLO_ATTEMPTED_PATH, _YOLO_ATTEMPTED_MTIME_NS
    model_path = next((path for path in YOLO_MODEL_CANDIDATES if path and path.is_file()), None)
    model_mtime_ns = model_path.stat().st_mtime_ns if model_path else None
    # A training run can deploy best.pt after Flask has already started.  Load
    # it on the next request, and reload when atomic deployment changes it.
    if _YOLO_MODEL is not None and model_path is not None and _YOLO_MODEL_MTIME_NS == model_path.stat().st_mtime_ns:
        return _YOLO_MODEL
    if (_YOLO_LOAD_ATTEMPTED and model_path == _YOLO_ATTEMPTED_PATH
            and model_mtime_ns == _YOLO_ATTEMPTED_MTIME_NS):
        return _YOLO_MODEL
    if _YOLO_MODEL is not None:
        _YOLO_MODEL = None
        _YOLO_LOAD_ATTEMPTED = False
    # This is invoked during Flask startup. A failed deployment remains in a
    # safe unavailable state until the service is restarted after best.pt is
    # fixed, rather than attempting to reload for every citizen upload.
    if _YOLO_LOAD_ATTEMPTED and model_path is None:
        return None
    _YOLO_LOAD_ATTEMPTED = True
    _YOLO_ATTEMPTED_PATH = model_path
    _YOLO_ATTEMPTED_MTIME_NS = model_mtime_ns
    if model_path is None:
        _YOLO_STATUS = {'ready': False, 'path': str(YOLO_MODEL_CANDIDATES[1]), 'model_version': None,
                        'error': 'YOLOv8 model not found. Please place best.pt inside the models folder.'}
        LOGGER.error('%s Expected path: %s', _YOLO_STATUS['error'], YOLO_MODEL_CANDIDATES[1])
        return None
    try:
        LOGGER.info('Loading custom YOLOv8 civic model from %s', model_path)
        from ultralytics import YOLO
        _YOLO_MODEL = YOLO(str(model_path))
        _YOLO_MODEL_MTIME_NS = model_path.stat().st_mtime_ns
        names = getattr(_YOLO_MODEL, 'names', {}) or {}
        LOGGER.info('YOLOv8 model loaded successfully. Class names: %s', dict(names))
        supported = {canonical_civic_category(label) for label in names.values()}
        if not any(supported):
            _YOLO_MODEL = None
            _YOLO_MODEL_MTIME_NS = None
            _YOLO_STATUS = {'ready': False, 'path': str(model_path), 'model_version': model_path.name,
                            'error': 'best.pt does not expose supported civic-problem classes.'}
            LOGGER.error('%s Model class names: %s', _YOLO_STATUS['error'], dict(names))
            return None
        _YOLO_STATUS = {'ready': True, 'path': str(model_path), 'model_version': model_path.name,
                        'class_names': dict(names), 'error': None}
        return _YOLO_MODEL
    except Exception as exc:
        _YOLO_MODEL_MTIME_NS = None
        _YOLO_STATUS = {'ready': False, 'path': str(model_path), 'model_version': model_path.name,
                        'error': f'YOLOv8 model could not be loaded: {exc}'}
        LOGGER.exception('YOLOv8 model load failed for %s', model_path)
        return None


def classify_civic_image_zero_shot(image_path):
    """Return the leading visual category from a general pretrained model.

    This is a candidate ranking, not a calibrated probability or a civic
    detector confirmation. Keep it separate from the deployed YOLO result.
    """
    global _CLIP_MODEL, _CLIP_PREPROCESS, _CLIP_TOKENIZER, _CLIP_TEXT_FEATURES
    started = time.perf_counter()
    try:
        import torch
        import open_clip
        from PIL import Image

        if _CLIP_MODEL is None:
            with _CLIP_LOCK:
                if _CLIP_MODEL is None:
                    model, _, preprocess = open_clip.create_model_and_transforms(
                        'ViT-B-32', pretrained='laion2b_s34b_b79k'
                    )
                    model.eval()
                    _CLIP_MODEL = model
                    _CLIP_PREPROCESS = preprocess
                    _CLIP_TOKENIZER = open_clip.get_tokenizer('ViT-B-32')
        with torch.inference_mode():
            if _CLIP_TEXT_FEATURES is None:
                descriptions = [
                    f'a photo of {prompt}.' for prompt in CLIP_CATEGORY_PROMPTS.values()
                ]
                tokens = _CLIP_TOKENIZER(descriptions)
                text_features = _CLIP_MODEL.encode_text(tokens)
                _CLIP_TEXT_FEATURES = text_features / text_features.norm(dim=-1, keepdim=True)
            with Image.open(image_path) as image:
                image_tensor = _CLIP_PREPROCESS(image.convert('RGB')).unsqueeze(0)
            image_features = _CLIP_MODEL.encode_image(image_tensor)
            image_features = image_features / image_features.norm(dim=-1, keepdim=True)
            similarities = (image_features @ _CLIP_TEXT_FEATURES.T)[0]
            best_indices = similarities.topk(k=2).indices.tolist()
        labels = list(CLIP_CATEGORY_PROMPTS)
        best_index, second_index = best_indices
        return {
            'candidate_category': labels[best_index],
            # Raw cosine similarities help with diagnostics, but are not shown
            # as percentages or interpreted as probabilities.
            'candidate_similarity': round(float(similarities[best_index]), 4),
            'candidate_margin': round(float(similarities[best_index] - similarities[second_index]), 4),
            'candidate_source': 'zero_shot',
            'model_version': _CLIP_MODEL_VERSION,
            'prediction_time_ms': round((time.perf_counter() - started) * 1000, 2),
        }
    except Exception as exc:
        LOGGER.exception('Zero-shot civic image classification failed for %s', image_path)
        return {'candidate_category': None, 'model_version': None,
                'prediction_time_ms': round((time.perf_counter() - started) * 1000, 2),
                'error': str(exc)}


def yolo_status():
    # The validation endpoint checks status before inference.  Initialise here
    # as well as at Flask startup so debug reloads and tests cannot leave it in
    # the misleading "not initialised" state.
    if not _YOLO_LOAD_ATTEMPTED:
        load_yolo_model()
    return dict(_YOLO_STATUS)


# Backwards compatible private alias for video validation.
_load_yolo = load_yolo_model


def validate_civic_image(image_path, selected_category):
    """Run real inference against the deployed ``best.pt`` civic model.

    Returns detections and an annotated PNG byte stream for the API to expose;
    no text heuristic or generic COCO model is used as a fallback.
    """
    model = load_yolo_model()
    selected = canonical_civic_category(selected_category)
    if model is None:
        return {'valid': False, 'status': 'invalid', 'selected_category': selected_category,
                'message': _YOLO_STATUS['error']}
    if not selected:
        return {'valid': False, 'status': 'invalid', 'selected_category': selected_category, 'message': 'Unsupported civic complaint category.'}
    try:
        if not os.path.isfile(image_path):
            raise FileNotFoundError(f'Temporary upload does not exist: {image_path}')
        image_size = os.path.getsize(image_path)
        if image_size == 0:
            raise ValueError('Temporary upload is empty')
        LOGGER.info('YOLOv8 inference starting: image_path=%s bytes=%s selected_category=%s', image_path, image_size, selected_category)
        started = time.perf_counter()
        result = model(image_path, conf=YOLO_PREDICTION_CONFIDENCE, verbose=False)[0]
        prediction_time_ms = round((time.perf_counter() - started) * 1000, 2)
        LOGGER.info('YOLOv8 raw prediction: %s', result.verbose())
        detections = []
        for box in result.boxes or []:
            raw_label = result.names[int(box.cls[0])]
            category = canonical_civic_category(raw_label)
            if not category:
                continue
            confidence = round(float(box.conf[0]) * 100, 2)
            coords = [round(float(value), 2) for value in box.xyxy[0].tolist()]
            detections.append({'category': category, 'label': str(raw_label), 'confidence': confidence,
                               'bounding_box': {'x1': coords[0], 'y1': coords[1], 'x2': coords[2], 'y2': coords[3]}})
            LOGGER.info('YOLOv8 detection: class=%s canonical_category=%s confidence=%.4f box=%s', raw_label, category, float(box.conf[0]), coords)
        best = max(detections, key=lambda item: item['confidence'], default=None)
        # A civic image can genuinely include more than one issue (for example
        # a pothole beside a blocked drain).  The complaint form asks the
        # citizen which issue they are reporting, so accept the strongest
        # detection of that selected class instead of rejecting it merely
        # because a different class has a slightly higher score.
        selected_detection = max(
            (item for item in detections if item['category'] == selected),
            key=lambda item: item['confidence'], default=None
        )
        if not best:
            LOGGER.info('YOLOv8 completed with zero supported detections: image_path=%s prediction_time_ms=%s', image_path, prediction_time_ms)
            return {'valid': False, 'status': 'invalid', 'selected_category': selected_category,
                    'detected_category': None, 'confidence': None, 'detections': [],
                    'prediction_time_ms': prediction_time_ms,
                    'message': 'No valid civic problem detected. Please upload a valid complaint image.'}
        annotated_png = None
        try:
            import cv2
            ok, encoded = cv2.imencode('.png', result.plot())
            annotated_png = encoded.tobytes() if ok else None
        except Exception:
            pass
        evaluated = selected_detection or best
        if selected_detection is None:
            message = f'The uploaded image does not match the selected complaint category. Please upload an image showing {selected_category}.'
        elif selected_detection['confidence'] < LOW_CONFIDENCE_REVIEW_PERCENT:
            message = f'Low-confidence {selected} match ({selected_detection["confidence"]}%). An official should visually verify this image.'
        elif selected_detection['confidence'] < VALIDATION_CONFIDENCE * 100:
            message = f'Civic issue confidence must be at least {VALIDATION_CONFIDENCE * 100:.0f}%. Please upload a clearer image.'
        else:
            message = 'Image validated successfully.'
        accepted = selected_detection is not None and selected_detection['confidence'] >= VALIDATION_CONFIDENCE * 100
        LOGGER.info('YOLOv8 inference completed: selected=%s detected=%s confidence=%s accepted=%s bounding_boxes=%s prediction_time_ms=%s', selected, evaluated['category'], evaluated['confidence'], accepted, len(detections), prediction_time_ms)
        return {'valid': accepted, 'status': 'valid' if accepted else 'invalid',
                'selected_category': selected_category, 'detected_category': evaluated['category'], 'confidence': evaluated['confidence'],
                'bounding_box': evaluated['bounding_box'], 'detections': detections, 'annotated_png': annotated_png,
                'model_version': _YOLO_STATUS['model_version'], 'prediction_time_ms': prediction_time_ms, 'message': message}
    except Exception as exc:
        LOGGER.exception('YOLOv8 inference failed for %s', image_path)
        return {'valid': False, 'status': 'invalid', 'selected_category': selected_category,
                'inference_error': True,
                'message': f'YOLOv8 inference failed: {exc}'}
def validate_civic_media(file_storage, selected_category):
    """Validate image/video evidence with a trained civic YOLOv8 model.

    A valid result is produced only when the strongest detected civic class
    equals the category chosen by the citizen and confidence exceeds 70%.
    """
    model = _load_yolo()
    if model is None:
        return {'valid': False, 'reason': 'Civic YOLOv8 model is not deployed. Evidence validation is unavailable.'}
    suffix = Path(file_storage.filename or '').suffix.lower()
    temp_path = None
    try:
        with NamedTemporaryFile(delete=False, suffix=suffix) as temp:
            file_storage.save(temp.name)
            temp_path = temp.name
        sources = [temp_path]
        if suffix in {'.mp4', '.mov', '.avi', '.mkv', '.webm'}:
            try:
                import cv2
                capture = cv2.VideoCapture(temp_path)
                total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
                frame_indexes = {int(total * ratio) for ratio in (0.1, 0.3, 0.5, 0.7, 0.9)}
                sources = []
                index = 0
                while True:
                    ok, frame = capture.read()
                    if not ok:
                        break
                    if index in frame_indexes:
                        sources.append(frame)
                    index += 1
                capture.release()
                if not sources:
                    return {'valid': False, 'reason': 'No readable key frames were found in the uploaded video.'}
            except Exception:
                return {'valid': False, 'reason': 'Video key-frame extraction failed.'}
        best = None
        for source in sources:
            result = model(source, verbose=False)[0]
            names = result.names
            for box in result.boxes or []:
                label = _normalise_yolo_label(names[int(box.cls[0])])
                confidence = float(box.conf[0])
                if label and (best is None or confidence > best['confidence']):
                    best = {'category': label, 'confidence': confidence}
        if not best:
            return {'valid': False, 'reason': 'No supported civic problem was detected in the uploaded evidence.'}
        confidence = round(best['confidence'] * 100, 1)
        if best['category'] != selected_category:
            return {'valid': False, 'detected_category': best['category'], 'confidence': confidence,
                    'reason': 'Uploaded image does not match the selected complaint category. Please upload the correct image.'}
        if confidence <= 70:
            return {'valid': False, 'detected_category': best['category'], 'confidence': confidence,
                    'reason': 'Civic issue confidence must be greater than 70%. Please upload a clearer image or video.'}
        return {'valid': True, 'detected_category': best['category'], 'confidence': confidence}
    finally:
        if temp_path:
            try: os.remove(temp_path)
            except OSError: pass


def _load_priority_rules():
    for candidate in (PRIORITY_RULES_PATH, LEGACY_PRIORITY_RULES_PATH):
        if candidate.exists():
            with candidate.open('r', encoding='utf-8') as handle:
                return json.load(handle)
    return {}


PRIORITY_RULES = _load_priority_rules()


def dataset_summary():
    """Return labelled-image counts. Dataset folders are the source of truth."""
    os.makedirs(DATASET_ROOT, exist_ok=True)
    counts = {}
    for category in CATEGORY_TERMS:
        folder = os.path.join(DATASET_ROOT, category.replace(' ', '_'))
        counts[category] = len([name for name in os.listdir(folder) if name.lower().endswith(('.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.webp', '.bmp', '.dib', '.tif', '.tiff', '.gif', '.avif', '.jp2', '.j2k', '.ico', '.tga'))]) if os.path.isdir(folder) else 0
    return counts


def dataset_health():
    """Describe all dataset areas without accidentally training on raw files."""
    image_counts = dataset_summary()
    minimum = 10
    raw_folder = Path(DATASET_ROOT) / 'raw'
    processed_folder = Path(DATASET_ROOT) / 'processed'
    raw_items = sorted(item.name for item in raw_folder.iterdir()) if raw_folder.is_dir() else []
    processed_items = sorted(item.name for item in processed_folder.iterdir()) if processed_folder.is_dir() else []
    categories = {
        category: {
            'images': count,
            'trainReady': count >= minimum,
            'needed': max(0, minimum - count),
        }
        for category, count in image_counts.items()
    }
    return {
        'minimumImagesPerClass': minimum,
        'categories': categories,
        'readyCategories': [name for name, info in categories.items() if info['trainReady']],
        'rawFolders': raw_items,
        'processedFolders': processed_items,
        'rawPolicy': 'Raw folders are source files only and are excluded from training until they are labelled and moved into a civic category folder.',
    }


def complaint_dataset_summary(limit=8):
    """Return the text-record and priority counts used to train the AI."""
    category_counts = Counter()
    priority_counts = Counter()
    sample_count = 0
    samples = []
    csv_files = []
    for candidate_dir in (COMPLAINT_DATASET_DIR, LEGACY_COMPLAINT_DATASET_DIR):
        if candidate_dir.is_dir():
            csv_files.extend(sorted(candidate_dir.glob('*.csv')))
    seen = set()
    for csv_path in csv_files:
        if csv_path in seen:
            continue
        seen.add(csv_path)
        with csv_path.open('r', encoding='utf-8-sig', newline='') as handle:
            for row in csv.DictReader(handle):
                complaint_text = (row.get('complaint_text') or '').strip()
                if not complaint_text:
                    continue
                category = _normalize_category(row.get('category'))
                priority = (row.get('priority') or row.get('priority_label') or 'Medium').strip().capitalize()
                normalized_priority = priority if priority in VALID_PRIORITIES else 'Medium'
                category_counts[category] += 1
                priority_counts[normalized_priority] += 1
                sample_count += 1
                if len(samples) < limit:
                    samples.append({
                        'complaint_text': complaint_text,
                        'category': category,
                        'priority': normalized_priority,
                        'source': (row.get('source') or csv_path.stem).strip(),
                        'location_hint': (row.get('location_hint') or '').strip(),
                    })
    return {
        'sampleCount': sample_count,
        'categoryDistribution': dict(sorted(category_counts.items())),
        'priorityDistribution': {priority: priority_counts.get(priority, 0) for priority in VALID_PRIORITIES},
        'samples': samples,
        'sourceFiles': [path.name for path in sorted(seen)],
    }


def _normalize_category(raw_category):
    if not raw_category:
        return 'Others'
    text = str(raw_category).strip().lower().replace(' ', '_')
    if text in CATEGORY_ALIASES:
        return CATEGORY_ALIASES[text]
    return str(raw_category)


def _load_text_model():
    global _TEXT_MODEL, _TEXT_MODEL_MTIME_NS
    if not TEXT_MODEL_PATH.exists():
        _TEXT_MODEL = None
        _TEXT_MODEL_MTIME_NS = None
        return None
    model_mtime = TEXT_MODEL_PATH.stat().st_mtime_ns
    if _TEXT_MODEL is not None and _TEXT_MODEL_MTIME_NS == model_mtime:
        return _TEXT_MODEL
    import joblib
    payload = joblib.load(TEXT_MODEL_PATH)
    _TEXT_MODEL = payload
    _TEXT_MODEL_MTIME_NS = model_mtime
    return _TEXT_MODEL


def clear_text_model_cache():
    """Force the next analysis request to load a newly trained model."""
    global _TEXT_MODEL, _TEXT_MODEL_MTIME_NS
    _TEXT_MODEL = None
    _TEXT_MODEL_MTIME_NS = None


def _predict_category_from_text(text):
    payload = _load_text_model()
    if payload is None or not text.strip():
        return None, None, None
    category_model = payload.get('category_model')
    priority_model = payload.get('priority_model')
    if category_model is None or priority_model is None:
        return None, None, None
    predicted_category = category_model.predict([text])[0]
    predicted_priority = priority_model.predict([text])[0]
    confidence = None
    if hasattr(category_model, 'predict_proba'):
        probs = category_model.predict_proba([text])[0]
        confidence = int(round(float(max(probs)) * 100))
    return _normalize_category(predicted_category), predicted_priority, confidence


def _derive_priority(text, category, severity):
    normalized = (text or '').lower()
    for priority in ('Critical', 'High', 'Medium', 'Low'):
        for rule in PRIORITY_RULES.get(priority, []):
            categories = rule.get('categories', [])
            keywords = rule.get('keywords', [])
            if any(keyword in normalized for keyword in keywords) and (not categories or category in categories):
                return priority, rule.get('reason', '')
    if severity >= 84:
        return 'Critical', 'High severity from urgency keywords'
    if severity >= 68:
        return 'High', 'Moderate urgency and public impact'
    if severity >= 52:
        return 'Medium', 'Routine follow-up required'
    return 'Low', 'Minor issue with low immediate impact'


def analyse_complaint(text='', selected_category='Others', image_count=0, nearby_reports=0):
    normalized = (text or '').lower()
    matches = Counter()
    for category, terms in CATEGORY_TERMS.items():
        matches[category] = sum(term in normalized for term in terms)
    inferred_category, score = matches.most_common(1)[0]
    dataset_counts = dataset_summary()

    predicted_category, predicted_priority, predicted_confidence = _predict_category_from_text(text or '')
    if predicted_category and predicted_category != 'Others':
        category = predicted_category
        confidence = predicted_confidence or max(62, min(98, 68 + score * 9 + image_count * 3))
    else:
        category = inferred_category if score else selected_category
        confidence = max(62, min(98, 68 + score * 9 + image_count * 3))

    datasetBacked = bool(dataset_counts.get(category, 0))
    critical_terms = ('fire', 'explosion', 'gas leak', 'electrocution', 'live wire', 'sparking', 'collapsed', 'injury', 'accident', 'emergency', 'unconscious', 'trapped')
    high_terms = ('danger', 'urgent', 'flood', 'overflow', 'sewage', 'unsafe', 'blocked', 'hospital', 'ambulance', 'school')
    category_baseline = {'Electricity': 25, 'Flood': 24, 'Fire': 30, 'Medical Emergency': 30, 'Traffic Signal': 20, 'Tree Fallen': 20, 'Water Leakage': 16, 'Drainage': 16, 'Road Damage': 12, 'Street Light': 8, 'Illegal Dumping': 8, 'Garbage': 6}
    critical_hits = sum(term in normalized for term in critical_terms)
    high_hits = sum(term in normalized for term in high_terms)
    severity = min(100, 20 + category_baseline.get(category, 5) + score * 8 + min(image_count, 3) * 2 + min(nearby_reports, 10) * 3 + critical_hits * 38 + high_hits * 12)
    predicted_priority = str(predicted_priority).strip().capitalize() if predicted_priority else None
    priority_rule, priority_reason = _derive_priority(text or '', category, severity)
    priority_rank = {name: index for index, name in enumerate(('Low', 'Medium', 'High', 'Critical'))}
    category_minimum = {
        'Electricity': 'High', 'Flood': 'High', 'Fire': 'High', 'Medical Emergency': 'High', 'Traffic Signal': 'High',
        'Tree Fallen': 'High', 'Water Leakage': 'Medium', 'Drainage': 'Medium',
        'Road Damage': 'Medium', 'Street Light': 'Medium', 'Illegal Dumping': 'Medium',
    }
    # The text model is used to assist category detection, but its priority
    # label is not trusted to escalate a report without explicit risk signals.
    # This prevents routine complaints from being incorrectly marked urgent.
    priority = max((priority_rule, category_minimum.get(category, 'Low')), key=lambda value: priority_rank[value])
    keywords = [term for term in normalized.replace(',', ' ').split() if len(term) > 3][:6]
    return {
        'category': category or 'Others', 'confidence': int(confidence), 'severity': severity, 'priority': priority, 'priorityReason': priority_reason, 'keywords': keywords,
        'sentiment': 'Urgent' if priority in ('Critical', 'High') else 'Concerned',
        'detectedObject': category or 'Civic issue',
        'model': 'CivicAI text classifier + keyword fallback',
        'datasetBacked': datasetBacked,
        'datasetExamples': dataset_counts.get(category, 0),
    }
