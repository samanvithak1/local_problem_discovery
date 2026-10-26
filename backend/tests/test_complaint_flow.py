import os
import shutil
import sys
import tempfile
import unittest


class ComplaintFlowTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix='civic-alert-', dir='c:/7thMajor/backend')
        self.db_path = os.path.join(self.tmpdir, 'test.db')
        os.environ['DATABASE_URI'] = f'sqlite:///{self.db_path}'
        os.environ['SECRET_KEY'] = 'test-secret'
        os.environ['JWT_SECRET_KEY'] = 'test-secret'
        sys.path.insert(0, 'c:/7thMajor/backend')
        import app as app_module
        self.app_module = app_module
        self.app = app_module.create_app()
        self.app.config['TESTING'] = True
        self.app_module.seed_defaults(self.app)
        with self.app.app_context():
            from models import db, User, Official
            db.session.query(Official).delete()
            db.session.query(User).delete()
            db.session.commit()
            user = User(
                full_name='Test Citizen',
                email='citizen@example.com',
                phone='+919999999999',
                password_hash=self.app_module.hash_password('password123'),
                district='Test District',
                taluk='Test Taluk',
                village='Test Village',
                address='Test Address',
            )
            official = Official(
                full_name='Test Official',
                email='official@example.com',
                phone='+919999999998',
                password_hash=self.app_module.hash_password('password123'),
                district='Test District',
                taluk='Test Taluk',
                village='Test Village',
                address='Test Address',
                employee_id='EMP-TEST-1',
                designation='Engineer',
                office_address='Test Office',
                approved=True,
            )
            db.session.add_all([user, official])
            db.session.commit()
            self.user_id = user.id
            self.official_id = official.id

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def valid_validation_id(self, category):
        """Create a completed YOLO audit for complaint-flow tests.

        Detector inference itself is covered separately; these tests exercise
        the downstream workflow only after the production gate has accepted
        evidence.
        """
        with self.app.app_context():
            from models import db, EvidenceValidation
            validation = EvidenceValidation(
                user_id=self.user_id, selected_category=category,
                detected_category=category, confidence=96.4,
                content_sha256=f'{category}-{os.urandom(24).hex()}',
                validation_status='valid', message='Image validated successfully.',
                model_version='best.pt',
            )
            db.session.add(validation)
            db.session.commit()
            return validation.id

    def test_user_profile_preflight_returns_success(self):
        client = self.app.test_client()
        response = client.options('/api/user/profile')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['message'], 'Preflight OK')

    def test_complaint_without_a_validated_image_is_rejected(self):
        client = self.app.test_client()
        login_resp = client.post('/api/auth/login/user', json={
            'email': 'citizen@example.com', 'password': 'password123',
        })
        token = login_resp.get_json()['data']['accessToken']
        with self.app.app_context():
            from models import Complaint
            before = Complaint.query.count()
        response = client.post('/api/complaints/create', json={
            'title': 'Road pothole', 'category': 'Road Damage',
            'description': 'A dangerous pothole needs repair.', 'location': 'Main Road',
        }, headers={'Authorization': f'Bearer {token}'})
        self.assertEqual(response.status_code, 422)
        with self.app.app_context():
            self.assertEqual(Complaint.query.count(), before)

    def test_user_profile_includes_user_complaints(self):
        client = self.app.test_client()
        login_resp = client.post('/api/auth/login/user', json={
            'email': 'citizen@example.com',
            'password': 'password123',
        })
        self.assertEqual(login_resp.status_code, 200)
        token = login_resp.get_json()['data']['accessToken']

        complaint_response = client.post('/api/complaints/create', json={
            'title': 'Broken street light',
            'category': 'Street Light',
            'description': 'A street light is broken and dangerous at night.',
            'location': 'Main Road',
            'latitude': '12.34',
            'longitude': '77.89',
            'validation_id': self.valid_validation_id('Street Light'),
        }, headers={'Authorization': f'Bearer {token}'})
        complaint_id = complaint_response.get_json()['data']['complaint']['id']

        profile_response = client.get('/api/user/profile', headers={'Authorization': f'Bearer {token}'})
        self.assertEqual(profile_response.status_code, 200)
        complaint_ids = [item['id'] for item in profile_response.get_json()['data']['complaints']]
        self.assertIn(complaint_id, complaint_ids)

    def test_complaint_submission_assigns_official_and_persists_alerts(self):
        client = self.app.test_client()
        login_resp = client.post('/api/auth/login/user', json={
            'email': 'citizen@example.com',
            'password': 'password123',
        })
        self.assertEqual(login_resp.status_code, 200)
        token = login_resp.get_json()['data']['accessToken']

        response = client.post('/api/complaints/create', json={
            'title': 'Broken street light',
            'category': 'Street Light',
            'description': 'A street light is broken and dangerous at night.',
            'location': 'Main Road',
            'latitude': '12.34',
            'longitude': '77.89',
            'validation_id': self.valid_validation_id('Street Light'),
        }, headers={'Authorization': f'Bearer {token}'})

        self.assertEqual(response.status_code, 201)
        payload = response.get_json()['data']
        complaint_id = payload['complaint']['id']

        with self.app.app_context():
            from models import Complaint, EmergencyAlert, Notification
            complaint = Complaint.query.get(complaint_id)
            self.assertIsNotNone(complaint)
            self.assertEqual(complaint.official_id, self.official_id)
            self.assertGreaterEqual(EmergencyAlert.query.filter_by(complaint_id=complaint_id).count(), 1)
            self.assertGreaterEqual(Notification.query.filter_by(official_id=self.official_id).count(), 1)

    def test_official_can_accept_reject_and_update_progress_with_photo(self):
        client = self.app.test_client()
        user_login = client.post('/api/auth/login/user', json={
            'email': 'citizen@example.com',
            'password': 'password123',
        })
        citizen_token = user_login.get_json()['data']['accessToken']
        complaint_response = client.post('/api/complaints/create', json={
            'title': 'Broken water pipeline',
            'category': 'Water Leakage',
            'description': 'Water is leaking heavily from a main pipe.',
            'location': 'Bhubaneshwar Road',
            'latitude': '12.99',
            'longitude': '77.99',
            'validation_id': self.valid_validation_id('Water Leakage'),
        }, headers={'Authorization': f'Bearer {citizen_token}'})
        complaint_id = complaint_response.get_json()['data']['complaint']['id']

        official_login = client.post('/api/auth/login/official', json={
            'email': 'official@example.com',
            'password': 'password123',
        })
        official_token = official_login.get_json()['data']['accessToken']

        accept_response = client.put(f'/api/complaints/{complaint_id}/update', json={
            'action': 'accept',
            'remarks': 'Accepted for inspection.'
        }, headers={'Authorization': f'Bearer {official_token}'})
        self.assertEqual(accept_response.status_code, 200)
        self.assertEqual(accept_response.get_json()['data']['complaint']['status'], 'Accepted')

        reject_response = client.put(f'/api/complaints/{complaint_id}/update', json={
            'action': 'reject',
            'remarks': 'Area is outside current jurisdiction.'
        }, headers={'Authorization': f'Bearer {official_token}'})
        self.assertEqual(reject_response.status_code, 200)
        self.assertEqual(reject_response.get_json()['data']['complaint']['status'], 'Rejected')

        progress_response = client.post(f'/api/complaints/{complaint_id}/progress', json={
            'statusName': 'In Progress',
            'remarks': 'Repair team has reached the site.',
            'completionImages': ['/uploads/progress-1.jpg']
        }, headers={'Authorization': f'Bearer {official_token}'})
        self.assertEqual(progress_response.status_code, 200)
        self.assertEqual(progress_response.get_json()['data']['complaint']['status'], 'In Progress')
        evidence = progress_response.get_json()['data']['complaint']['completion_images']
        self.assertTrue(evidence)
        self.assertEqual(evidence[0]['phase'], 'In Progress')

    def test_citizen_endpoints_only_expose_the_authenticated_users_complaints(self):
        with self.app.app_context():
            from flask_jwt_extended import create_access_token
            from models import db, User, Complaint, ComplaintStatus

            other_user = User(
                full_name='Other Citizen',
                email='other-citizen@example.com',
                phone='+919999999997',
                password_hash=self.app_module.hash_password('password123'),
                district='Other District',
                taluk='Other Taluk',
                village='Other Village',
                address='Other Address',
            )
            db.session.add(other_user)
            db.session.flush()
            submitted = ComplaintStatus.query.filter_by(name='Submitted').first()
            own_complaint = Complaint(
                title='Own complaint', category='Road Damage', description='Own issue',
                priority='Low', location='Own location', user_id=self.user_id,
                status_id=submitted.id, latitude='12.34', longitude='77.89',
            )
            other_complaint = Complaint(
                title='Other complaint', category='Road Damage', description='Private issue',
                priority='Low', location='Private location', user_id=other_user.id,
                status_id=submitted.id, latitude='12.34', longitude='77.89',
            )
            db.session.add_all([own_complaint, other_complaint])
            db.session.commit()
            own_id = own_complaint.id
            other_id = other_complaint.id
            token = create_access_token(
                identity=str(other_user.id),
                additional_claims={'role': 'user', 'name': other_user.full_name},
            )

        client = self.app.test_client()
        headers = {'Authorization': f'Bearer {token}'}
        complaints_response = client.get('/api/complaints/', headers=headers)
        complaint_ids = [
            item['id'] for item in complaints_response.get_json()['data']['complaints']
        ]
        self.assertEqual(complaints_response.status_code, 200)
        self.assertEqual(complaint_ids, [other_id])

        profile_response = client.get('/api/user/profile', headers=headers)
        profile_ids = [
            item['id'] for item in profile_response.get_json()['data']['complaints']
        ]
        self.assertEqual(profile_response.status_code, 200)
        self.assertEqual(profile_ids, [other_id])

        stats_response = client.get('/api/complaints/stats', headers=headers)
        self.assertEqual(stats_response.status_code, 200)
        self.assertEqual(stats_response.get_json()['data']['summary']['totalComplaints'], 1)

        nearby_response = client.get(
            '/api/complaints/nearby?latitude=12.34&longitude=77.89',
            headers=headers,
        )
        nearby_ids = [
            item['id'] for item in nearby_response.get_json()['data']['complaints']
        ]
        self.assertEqual(nearby_response.status_code, 200)
        self.assertEqual(nearby_ids, [other_id])

        update_response = client.put(
            f'/api/complaints/{own_id}/update',
            json={'remarks': 'Attempted cross-account update'},
            headers=headers,
        )
        delete_response = client.delete(f'/api/complaints/{own_id}', headers=headers)
        self.assertEqual(update_response.status_code, 403)
        self.assertEqual(delete_response.status_code, 404)

    def test_unsupported_jwt_role_cannot_list_or_update_complaints(self):
        with self.app.app_context():
            from flask_jwt_extended import create_access_token

            token = create_access_token(
                identity='1',
                additional_claims={'role': 'support', 'name': 'Unsupported'},
            )

        client = self.app.test_client()
        headers = {'Authorization': f'Bearer {token}'}
        list_response = client.get('/api/complaints/', headers=headers)
        stats_response = client.get('/api/complaints/stats', headers=headers)
        anonymous_stats_response = client.get('/api/complaints/stats')
        update_response = client.put(
            '/api/complaints/1/update',
            json={'statusName': 'Resolved'},
            headers=headers,
        )
        self.assertEqual(list_response.status_code, 403)
        self.assertEqual(stats_response.status_code, 403)
        self.assertEqual(anonymous_stats_response.status_code, 401)
        self.assertEqual(update_response.status_code, 403)

    def test_uploaded_complaint_evidence_requires_owner_or_authorized_staff(self):
        with self.app.app_context():
            from flask_jwt_extended import create_access_token
            from models import db, Complaint, ComplaintStatus, EvidenceValidation, Image

            submitted = ComplaintStatus.query.filter_by(name='Submitted').first()
            complaint = Complaint(
                title='Private evidence', category='Road Damage', description='Evidence issue',
                priority='Low', location='Private location', user_id=self.user_id,
                status_id=submitted.id,
            )
            db.session.add(complaint)
            db.session.flush()
            filename = f'{complaint.id}_evidence.jpg'
            db.session.add(Image(
                complaint_id=complaint.id, url=f'/uploads/{filename}',
                phase='Citizen complaint evidence',
            ))
            validation_path = '/uploads/validations/evidence.jpg'
            db.session.add(EvidenceValidation(
                user_id=self.user_id,
                selected_category='Road Damage',
                content_sha256='a' * 64,
                validation_status='valid',
                message='Evidence validated.',
                image_path=validation_path,
            ))
            db.session.add(Image(
                complaint_id=complaint.id, url=validation_path,
                phase='Validated evidence',
            ))
            db.session.commit()
            own_token = create_access_token(
                identity=str(self.user_id),
                additional_claims={'role': 'user', 'name': 'Test Citizen'},
            )
            other_token = create_access_token(
                identity='9999',
                additional_claims={'role': 'user', 'name': 'Other Citizen'},
            )
            official_token = create_access_token(
                identity=str(self.official_id),
                additional_claims={'role': 'official', 'name': 'Test Official'},
            )
            upload_folder = os.path.join(self.tmpdir, 'uploads')
            validation_folder = os.path.join(upload_folder, 'validations')
            os.makedirs(validation_folder, exist_ok=True)
            with open(os.path.join(upload_folder, filename), 'wb') as evidence:
                evidence.write(b'private evidence')
            with open(os.path.join(validation_folder, 'evidence.jpg'), 'wb') as evidence:
                evidence.write(b'validated evidence')
            self.app.config['UPLOAD_FOLDER'] = upload_folder

        client = self.app.test_client()
        path = f'/uploads/{filename}'
        validation_url = '/uploads/validations/evidence.jpg'
        owner_response = client.get(path, headers={'Authorization': f'Bearer {own_token}'})
        other_response = client.get(path, headers={'Authorization': f'Bearer {other_token}'})
        official_response = client.get(
            validation_url, headers={'Authorization': f'Bearer {official_token}'}
        )
        anonymous_response = client.get(path)
        self.assertEqual(owner_response.status_code, 200)
        self.assertEqual(owner_response.headers['Cache-Control'], 'private, no-store')
        self.assertEqual(other_response.status_code, 403)
        self.assertEqual(official_response.status_code, 200)
        self.assertEqual(anonymous_response.status_code, 401)


if __name__ == '__main__':
    unittest.main()
