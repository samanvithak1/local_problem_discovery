# Production deployment

This application is deployed as two public services: the React/Vite frontend on Vercel and the Flask API (including the custom civic YOLOv8 model) on a persistent Python host. Do **not** deploy the YOLO model to a Vercel serverless function.

## Architecture

```text
Browser → Vercel frontend (HTTPS) → Flask API / YOLO service (HTTPS)
                                      ├─ MySQL-compatible database
                                      └─ S3-compatible object storage
```

The existing detector expects the custom civic checkpoint (`YOLO_MODEL_PATH`) and maps only these civic categories: Road Damage, Garbage, Water Leakage, Drainage, Street Light, Tree Fallen, Electricity, and Illegal Dumping. Do not substitute a COCO checkpoint.

## 1. Provision services

1. Create a MySQL-compatible managed database (for example, PlanetScale, Aiven MySQL, DigitalOcean Managed MySQL, or Railway MySQL).
2. Create an S3-compatible private evidence bucket (AWS S3, Cloudflare R2, or Supabase Storage) and configure restricted read access/signed URLs as required by your provider.
3. Create a persistent Python service for the Flask API and YOLO model. Railway, Render, Fly.io, or a VM/container service with enough RAM for the custom model are suitable.
4. Copy the trained custom `best.pt` checkpoint to the backend host or mount it as a persistent volume. Never commit a private production checkpoint or cloud credentials.

## 2. Backend environment variables

Set these on the API/YOLO host. Do not commit a real `.env` file.

```ini
FLASK_ENV=production
SECRET_KEY=<long-random-secret>
JWT_SECRET_KEY=<different-long-random-secret>
DATABASE_URI=mysql+pymysql://<user>:<password>@<host>:3306/<database>?charset=utf8mb4
FRONTEND_URL=https://<your-vercel-project>.vercel.app
CORS_ORIGINS=https://<your-vercel-project>.vercel.app
OFFICIAL_AUTO_APPROVE=false
ADMIN_SETUP_KEY=<private-bootstrap-key>
GOVERNMENT_APPROVAL_CODE=<private-government-code>
MAX_UPLOAD_BYTES=10485760
YOLO_MODEL_PATH=/app/models/best.pt
GOOGLE_CLIENT_ID=803354370207-30c9ir1p644jap3iankqurh3bm7f464r.apps.googleusercontent.com
STORAGE_BACKEND=s3
STORAGE_BUCKET=<bucket-name>
STORAGE_REGION=<region>
STORAGE_ACCESS_KEY=<server-only-key>
STORAGE_SECRET_KEY=<server-only-secret>
```

Use the database migration/schema process before accepting real users. Verify with `GET /api/health`; it must report the YOLO service ready before enabling submissions.

## 3. Deploy the backend and YOLO service

From `backend/` on the Python host:

```bash
pip install -r requirements.txt
gunicorn --worker-class eventlet --workers 1 --bind 0.0.0.0:$PORT wsgi:app
```

If the host does not support Socket.IO/eventlet, run the Flask-SocketIO server process recommended by that host instead. Configure its health check as `/api/health`, allow HTTPS only, and set its public URL as the frontend API URL.

## 4. Deploy the frontend to Vercel

Import the repository in Vercel and choose `frontend` as the project root. Configure these **Production** variables:

```ini
VITE_API_BASE_URL=https://<your-api-domain>
VITE_SOCKET_URL=https://<your-api-domain>
VITE_GOOGLE_CLIENT_ID=803354370207-30c9ir1p644jap3iankqurh3bm7f464r.apps.googleusercontent.com
```

Deploy with the Vercel build command `npm run build`. The committed `vercel.json` rewrites every client route to `index.html`, so refreshes on `/dashboard` and authentication routes do not return 404.

After Vercel gives you its final URL, update `FRONTEND_URL` and `CORS_ORIGINS` on the API service, then redeploy/restart the API.

## 5. Google Maps and location

Create a Google Maps browser key restricted to your Vercel domain only. Restrict the OAuth web client redirect/origin settings to the Vercel URL. Never put any server-side Google secret in `VITE_*` variables.

## 6. Evidence storage

Production evidence must be stored in object storage, not in the backend `uploads/` folder. Configure the chosen provider's server-only access credentials on the backend, retain the resulting object URL/key in the database, and enforce the existing file type and size restrictions. Test both a complaint image and official progress image after deployment.

## 7. Public URL acceptance checklist

- Open the Vercel HTTPS URL from a phone using mobile data and from a separate network.
- Register a real citizen, log in, and submit a valid civic image using the custom YOLO model.
- Confirm category mismatch and low-confidence images are rejected with an error.
- Confirm priority, status history, notification, and evidence URL persist after browser refresh.
- Register an official, approve it as an admin, then verify department-scoped assignment and updates.
- Verify a citizen cannot access another citizen's data and unauthenticated calls return 401/403.
- Refresh `/dashboard`, login, and registration routes directly; none should show a Vercel 404.

## 8. Real-user evaluation and feedback

Share the public URL with at least 20 actual participants only after the above checklist passes. Do not seed or claim fabricated users, complaints, reviews, or survey results.

Use a real form provider (Google Forms or Microsoft Forms) and collect: user type; ease of use; complaint submission; AI image validation; tracking; notifications; overall satisfaction; and suggestions. Link its public form URL from the deployed application or share it after each test. Export only genuine responses and summarize the count, averages, and anonymized suggestions in the admin report for the evaluation.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser CORS error | The exact Vercel origin must be in `CORS_ORIGINS`; restart the API. |
| Vercel API request fails | Set `VITE_API_BASE_URL` to the public API URL and redeploy Vercel. |
| YOLO unavailable | Verify `YOLO_MODEL_PATH`, model file permissions, and `/api/health`. |
| Upload disappears after restart | Configure object storage; host-local disk is not production storage. |
| Database connection failure | Validate the `mysql+pymysql://` URI, TLS/network allowlist, and schema. |
| Route refresh 404 | Confirm Vercel project root is `frontend` and `vercel.json` was deployed. |
