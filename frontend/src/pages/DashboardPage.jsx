import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Card, CardContent, Chip, Grid, IconButton, LinearProgress, MenuItem, Select, Snackbar, Stack, TextField, Typography } from '@mui/material';
import { AddLocationAlt, Analytics, Assignment, Campaign, CloudUpload, Delete, Download, Engineering, EventAvailable, Insights, Logout, Map, MyLocation, NotificationsActive, Person, Phone, Psychology, Report, Route, Settings, TaskAlt, Warning } from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import api, { dialNumber } from '../services/api';
import { AuthenticatedAssetLink, AuthenticatedImage } from '../components/AuthenticatedAsset';
import { useTranslation } from 'react-i18next';
import OfficialDashboard from './OfficialDashboard';
import AdminDashboard from './AdminDashboard';
import { CIVIC_CATEGORIES, findCategoryMention } from '../constants/civicCategories';

// Categories without a deployed detector class are routed for official review.
const categories = CIVIC_CATEGORIES;
const categoryKeys = { 'Road Damage': 'roadDamage', Garbage: 'garbage', 'Street Light': 'streetLight', 'Water Leakage': 'waterLeakage', Drainage: 'drainage', Electricity: 'electricity', 'Tree Fallen': 'treeFallen', 'Illegal Dumping': 'illegalDumping', 'Traffic Signal': 'trafficSignal', 'Public Property Damage': 'publicPropertyDamage', 'Animal Issue': 'animalIssue', Flood: 'flood', Fire: 'fire', 'Medical Emergency': 'medicalEmergency', Others: 'others' };
const priorityColors = { Critical: 'error', High: 'warning', Medium: 'info', Low: 'success' };
const statusSteps = ['Submitted', 'Verified', 'Assigned', 'Work Started', 'Completed', 'Closed'];

const StatusChip = ({ value }) => <Chip size="small" label={value || 'Submitted'} color={value === 'Resolved' || value === 'Completed' ? 'success' : 'primary'} />;
const PriorityChip = ({ value }) => <Chip size="small" label={`${value || 'Medium'} priority`} color={priorityColors[value] || 'info'} />;
const formatDisplayDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const contactSupports = (contact, channel) => (contact?.channels || ['call']).includes(channel);
const contactNumber = contact => String(contact?.number || '').replace(/[^0-9+]/g, '');
const contactSmsHref = (contact, body) => `sms:${contactNumber(contact)}?body=${encodeURIComponent(body)}`;

export default function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [complaints, setComplaints] = useState([]); const [dashboard, setDashboard] = useState({});
  const [files, setFiles] = useState([]); const [analysis, setAnalysis] = useState(null); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); const [query, setQuery] = useState(''); const [sort, setSort] = useState('newest');
  const [emergencyContacts, setEmergencyContacts] = useState([]);
  const [form, setForm] = useState({ title: '', category: 'Road Damage', description: '', location: '', latitude: '', longitude: '' });
  const [uploadProgress, setUploadProgress] = useState(0);
  const [imageValidation, setImageValidation] = useState(null);
  const [validationBusy, setValidationBusy] = useState(false);
  const imageValidationRequestId = useRef(0);
  const categoryMention = findCategoryMention(`${form.title} ${form.description}`, form.category);

  const load = async () => {
    try {
      const endpoint = user.role === 'user' || user.role === 'citizen' ? '/user/profile' : user.role === 'official' ? '/official/profile' : '/admin/dashboard';
      const profile = await api.get(endpoint);
      setDashboard(profile.data.data || {});
      const list = await api.get('/complaints/');
      setComplaints(list.data.data.complaints || profile.data.data?.assignedComplaints || profile.data.data?.complaints || []);
      const emergency = await api.get('/emergency/india');
      setEmergencyContacts(emergency.data.data || []);
    } catch (error) {
      const msg = error?.response?.data?.message || error?.message || 'Unable to load dashboard';
      setNotice({ type: 'error', text: msg });
    }
  };
  useEffect(() => {
    if (!user) return undefined;
    load();
    const refreshTimer = window.setInterval(load, 5000);
    let socket = null;
    let active = true;
    const onConnect = () => console.log('Socket connected', socket?.id);
    const onComplaintCreated = (payload) => {
      const complaint = payload?.complaint;
      if (complaint) setComplaints(previous => [complaint, ...previous.filter(item => item.id !== complaint.id)]);
    };
    const onComplaintUpdated = (payload) => {
      const incoming = payload?.complaint;
      if (incoming?.id) setComplaints(previous => previous.map(item => item.id === incoming.id ? incoming : item));
      if (payload?.complaintId && payload?.imageUrls) {
        setComplaints(previous => previous.map(item => item.id === payload.complaintId
          ? { ...item, completion_images: (item.completion_images || []).concat(payload.imageUrls) } : item));
      }
    };
    const onComplaintDeleted = (payload) => {
      if (payload?.complaintId) setComplaints(previous => previous.filter(item => item.id !== payload.complaintId));
    };

    // Real-time socket updates
    import('../services/socket').then(({ connectSocket }) => {
      if (!active) return;
      socket = connectSocket();
      socket.on('connect', onConnect);
      socket.on('complaint.created', onComplaintCreated);
      socket.on('complaint.updated', onComplaintUpdated);
      socket.on('complaint.deleted', onComplaintDeleted);
    }).catch(() => {});

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      if (socket) {
        socket.off('connect', onConnect);
        socket.off('complaint.created', onComplaintCreated);
        socket.off('complaint.updated', onComplaintUpdated);
        socket.off('complaint.deleted', onComplaintDeleted);
      }
      import('../services/socket').then(({ disconnectSocket }) => disconnectSocket()).catch(() => {});
    };
  }, [user]);
  const updateForm = key => event => setForm(previous => ({ ...previous, [key]: event.target.value }));
  const analyze = async () => {
    if (!form.description && !form.title) return setNotice({ type: 'info', text: 'Add a description for AI analysis.' });
    setBusy(true); try { const response = await api.post('/ai/analyze', { text: `${form.title} ${form.description}`, category: form.category, imageCount: files.length }); setAnalysis(response.data.data.analysis); }
    catch (error) { setNotice({ type: 'error', text: error.message || 'AI analysis is unavailable.' }); } finally { setBusy(false); }
  };
  const locate = () => navigator.geolocation?.getCurrentPosition(
    p => setForm(previous => ({ ...previous, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6), location: previous.location || 'Current location' })),
    () => setNotice({ type: 'error', text: 'Location permission was not granted. You can enter it manually.' })
  );
  const validateSelectedImage = async (file, selectedCategory) => {
    if (!file) return;
    const requestId = ++imageValidationRequestId.current;
    setValidationBusy(true);
    setImageValidation({ status: 'loading', selected_category: selectedCategory, message: 'Running AI validation...' });
    try {
      const data = new FormData(); data.append('selected_category', selectedCategory); data.append('image', file);
      const response = await api.post('/validate-image', data);
      if (requestId === imageValidationRequestId.current) setImageValidation(response.data);
    } catch (error) {
      const result = error?.response?.data || {};
      if (requestId === imageValidationRequestId.current) setImageValidation({ ...result, status: result.status || 'invalid', selected_category: result.selected_category || selectedCategory, message: result.message || 'Image validation could not be completed.' });
    } finally { if (requestId === imageValidationRequestId.current) setValidationBusy(false); }
  };
  const decideExtensionRequest = async (complaint, request, decision) => {
    try {
      const response = await api.put(`/complaints/${complaint.id}/extension-requests/${request.id}`, { decision });
      setNotice({ type: 'success', text: response.data?.message || `Time request ${decision === 'approve' ? 'approved' : 'declined'}.` });
      await load();
    } catch (error) {
      setNotice({ type: 'error', text: error?.response?.data?.message || 'Could not update the time-extension request.' });
    }
  };
  const chooseEvidence = event => {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    imageValidationRequestId.current += 1;
    setFiles(selected); setImageValidation(null);
  };
  const changeCategory = event => {
    const category = event.target.value;
    imageValidationRequestId.current += 1;
    setForm(previous => ({ ...previous, category })); setImageValidation(null);
  };
  // Validate immediately after the citizen chooses a file, and again if they
  // switch the selected complaint category.
  useEffect(() => {
    if (files[0]) validateSelectedImage(files[0], form.category);
  }, [files, form.category]);
  const submit = async event => {
    event.preventDefault(); setBusy(true); setUploadProgress(0);
    // Client-side validation
    if (!form.title || !form.description) { setNotice({ type: 'error', text: 'Title and description are required.' }); setBusy(false); return; }
    if (!files.length) { setNotice({ type: 'error', text: 'A clear photo or video of the civic issue is required.' }); setBusy(false); return; }
    if (form.latitude && isNaN(Number(form.latitude))) { setNotice({ type: 'error', text: 'Latitude must be a number.' }); setBusy(false); return; }
    if (form.longitude && isNaN(Number(form.longitude))) { setNotice({ type: 'error', text: 'Longitude must be a number.' }); setBusy(false); return; }

    try {
      if (!['valid', 'review_required'].includes(imageValidation?.status) || !imageValidation?.validation_id) throw new Error(imageValidation?.message || 'Wait for image validation before submitting.');
      const response = await api.post('/complaints/create', { ...form, imageCount: files.length, validation_id: imageValidation.validation_id });
      const complaint = response.data.data.complaint;
      const alerts = response.data.data.alerts || {};
      const alertMessage = alerts.officialCount ? `Complaint submitted successfully. ${alerts.officialCount} official alert${alerts.officialCount === 1 ? '' : 's'} dispatched.` : 'Complaint submitted successfully.';
      // If there are files, upload with progress
      if (files.length) {
        const data = new FormData(); files.slice(1).forEach(file => data.append('mediaFile', file));
        if (files.length > 1) await api.post(`/complaints/${complaint.id}/upload-media`, data, {
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              setUploadProgress(percent);
            }
          }
        });
      }
      setAnalysis(response.data.data.analysis);
      setNotice({ type: 'success', text: response.data.data.analysis.priority === 'Critical' ? `Critical complaint submitted. Emergency alerts dispatched to ${alerts.officialCount || 0} officials.` : alertMessage });
      setForm({ title: '', category: 'Road Damage', description: '', location: '', latitude: '', longitude: '' }); setFiles([]); setUploadProgress(0); load();
    } catch (error) {
      const msg = error?.response?.data?.message || error?.response?.data?.data?.error || error?.message || 'Could not submit complaint.';
      setNotice({ type: 'error', text: msg });
    } finally { setBusy(false); }
  };
  const filtered = useMemo(() => complaints.filter(c => `${c.title} ${c.category} ${c.status}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => sort === 'priority' ? ['Critical','High','Medium','Low'].indexOf(a.priority) - ['Critical','High','Medium','Low'].indexOf(b.priority) : new Date(b.created_at) - new Date(a.created_at)), [complaints, query, sort]);
  const mapQuery = form.latitude && form.longitude ? `${form.latitude},${form.longitude}` : form.location || 'Karnataka, India';
  const mapSource = `https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}&z=${form.latitude ? 17 : 11}&output=embed`;
  const active = complaints.filter(c => !['Resolved', 'Completed', 'Closed'].includes(c.status)).length; const done = complaints.length - active;
  const slaNotifications = [...(dashboard.notifications || [])].filter(item => /overdue|resolution target|not completed|extra time|time-extension/i.test(item.message || '')).reverse().slice(0, 5);
  const receipt = complaint => { const blob = new Blob([`SMART CIVIC AI\nComplaint #${complaint.id}\n${complaint.title}\nPriority: ${complaint.priority}\nLocation: ${complaint.location}\nStatus: ${complaint.status}`], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `complaint-${complaint.id}-receipt.txt`; a.click(); URL.revokeObjectURL(a.href); };
  const deleteComplaint = async complaint => { if (!window.confirm(`Delete complaint #${complaint.id}? This cannot be undone.`)) return; try { await api.delete(`/complaints/${complaint.id}`); setNotice({ type: 'success', text: 'Complaint deleted.' }); load(); } catch (error) { setNotice({ type: 'error', text: error?.response?.data?.message || 'Unable to delete complaint.' }); } };
  if (user?.role === 'official') return <OfficialDashboard user={user} complaints={complaints} dashboard={dashboard} reload={load} logout={() => { logout(); navigate('/'); }} />;
  if (user?.role === 'admin') return <AdminDashboard dashboard={dashboard} complaints={complaints} reload={load} logout={() => { logout(); navigate('/'); }} />;
  if (user?.role !== 'user' && user?.role !== 'citizen') return <RoleDashboard user={user} complaints={complaints} dashboard={dashboard} reload={load} logout={() => { logout(); navigate('/'); }} />;
  return <Box sx={{ py: 2 }}>
    <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} spacing={2} sx={{ mb: 3 }}>
      <Box><Typography variant="h4" fontWeight={800}>{t('goodDay', { name: user?.name?.split(' ')[0] || t('citizen') })}</Typography><Typography color="text.secondary">{t('dashboardSub')}</Typography></Box>
      <Stack direction="row" spacing={1}><Button startIcon={<Analytics />} onClick={() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' })}>{t('myHistory')}</Button><IconButton color="primary"><NotificationsActive /></IconButton><Button variant="outlined" startIcon={<Logout />} onClick={() => { logout(); navigate('/'); }}>{t('signOut')}</Button></Stack>
    </Stack>
    {slaNotifications.length > 0 && <Stack spacing={1} sx={{ mb: 2 }}>{slaNotifications.map(item => <Alert key={item.id} severity="warning">{item.message}</Alert>)}</Stack>}
    {complaints.some(item => item.sla_due_at) && <Card sx={{ mb: 2, borderRadius: 3 }}><CardContent><Typography variant="subtitle1" fontWeight={750}>Resolution targets and deadlines</Typography><Stack spacing={1} mt={1}>{complaints.filter(item => item.sla_due_at && !['Resolved', 'Completed', 'Closed', 'Rejected'].includes(item.status)).map(item => { const remaining = new Date(item.sla_due_at).getTime() - Date.now(); const hours = Math.ceil(Math.abs(remaining) / 3600000); return <Stack key={item.id} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={.5}><Typography variant="body2">#{item.id} · {item.title} · target {item.sla_target_hours || '—'}h</Typography><Typography variant="body2" color={remaining < 0 ? 'error.main' : 'text.secondary'}>Due {formatDisplayDate(item.sla_due_at)} · {remaining < 0 ? `overdue by ${hours}h` : `${hours}h remaining`}</Typography></Stack>; })}</Stack></CardContent></Card>}
    <Grid container spacing={2} sx={{ mb: 3 }}>
      {[[t('totalReports'), complaints.length, 'primary'], [t('activeCases'), active, 'warning'], [t('completed'), done, 'success'], [t('aiReady'), t('online'), 'secondary']].map(([label, value, color]) => <Grid item xs={6} md={3} key={label}><Card sx={{ borderRadius: 4 }}><CardContent><Typography color="text.secondary" variant="body2">{label}</Typography><Typography variant="h4" color={`${color}.main`} fontWeight={800}>{value}</Typography></CardContent></Card></Grid>)}
    </Grid>
    <Grid container spacing={3}><Grid item xs={12} lg={7}><Card sx={{ borderRadius: 4 }}><CardContent>
      <Stack direction="row" alignItems="center" spacing={1} mb={1}><CloudUpload color="primary" /><Typography variant="h6" fontWeight={750}>{t('fileComplaint')}</Typography></Stack><Typography color="text.secondary" variant="body2" mb={3}>{t('complaintHelp')}</Typography>
      <Box component="form" onSubmit={submit}><Grid container spacing={2}><Grid item xs={12} md={6}><TextField required fullWidth label={t('title')} value={form.title} onChange={updateForm('title')} /></Grid><Grid item xs={12} md={6}><TextField select fullWidth label={t('category')} value={form.category} onChange={changeCategory}>{categories.map(c => <MenuItem value={c} key={c}>{t(categoryKeys[c])}</MenuItem>)}</TextField></Grid><Grid item xs={12}><TextField required multiline minRows={4} fullWidth label={t('description')} value={form.description} onChange={updateForm('description')} /></Grid>
      <Grid item xs={12}><Button component="label" variant="outlined" startIcon={<CloudUpload />}>{t('evidence')}<input hidden multiple accept=".jpg,.jpeg,.jpe,.jfif,.png,.apng,.webp,.bmp,.dib,.tif,.tiff,.gif,.avif,.jp2,.j2k,.ico,.tga" type="file" onChange={chooseEvidence} /></Button><Typography variant="caption" color="text.secondary" display="block" mt={1}>Accepted: JPG, PNG, WebP, BMP, TIFF, GIF, AVIF, and JPEG 2000. AI checks supported categories at a lower threshold; if it cannot confirm the image, you can submit it for official review.</Typography>{categoryMention && <Alert severity="warning" sx={{ mt: 2 }}>Your title or description mentions {categoryMention}, but the selected category is {form.category}. Check the category before submitting; this is a text cue, not an image prediction.</Alert>}{files.length > 0 && <Stack direction="row" flexWrap="wrap" gap={1} mt={1}>{files.map(file => <Chip key={`${file.name}-${file.size}`} label={file.name} onDelete={() => setFiles(prev => prev.filter(f => f !== file))} />)}</Stack>}{imageValidation && <Alert severity={imageValidation.status === 'loading' ? 'info' : imageValidation.status === 'valid' && imageValidation.candidate_source === 'zero_shot' ? 'warning' : imageValidation.status === 'valid' ? 'success' : imageValidation.status === 'review_required' || imageValidation.status === 'unavailable' || imageValidation.status === 'duplicate' ? 'warning' : 'error'} sx={{ mt: 2 }}><b>{imageValidation.status === 'loading' ? 'Loading... Running AI validation...' : imageValidation.status === 'valid' ? (imageValidation.candidate_source === 'zero_shot' ? 'AI visual match accepted' : 'Image Valid') : imageValidation.status === 'duplicate' ? 'Image already submitted' : imageValidation.status === 'review_required' ? 'Official image review required' : imageValidation.status === 'unavailable' ? 'Detector Unavailable' : 'Invalid Image'}</b><br />Selected: {imageValidation.selected_category}<br />Detected: {(imageValidation.status === 'review_required' || imageValidation.status === 'duplicate') && imageValidation.candidate_category ? 'Not confirmed by AI' : imageValidation.detected_category || (imageValidation.status === 'review_required' ? 'Not assessed by AI' : 'No detection returned')}{(imageValidation.status === 'review_required' || imageValidation.status === 'duplicate' || imageValidation.status === 'valid' && imageValidation.candidate_source === 'zero_shot') && imageValidation.candidate_category && <><br />AI candidate: {imageValidation.candidate_category}{imageValidation.candidate_source === 'zero_shot' ? (imageValidation.status === 'valid' ? ' (best visual match; accepted, uncalibrated)' : ' (best visual match; unconfirmed)') : imageValidation.candidate_confidence != null ? ` (${imageValidation.candidate_confidence}% candidate score; unconfirmed)` : ' (unconfirmed)'}</>}<br />Confidence: {imageValidation.confidence ?? '—'}%{imageValidation.prediction_time_ms != null && <><br />Prediction time: {imageValidation.prediction_time_ms} ms</>}{imageValidation.message && <><br />{imageValidation.message}</>}{imageValidation.bounding_box_image && <><br /><AuthenticatedImage url={imageValidation.bounding_box_image} alt="YOLO bounding box preview" style={{ marginTop: 8, maxHeight: 180, maxWidth: '100%', borderRadius: 8 }} /></>}</Alert>}</Grid>
      <Grid item xs={12}>{uploadProgress > 0 && uploadProgress < 100 && <Box sx={{ mt: 2 }}><LinearProgress variant="determinate" value={uploadProgress} /><Typography variant="caption" color="text.secondary">Uploading attachments: {uploadProgress}%</Typography></Box>}
      </Grid>
      <Grid item xs={12} md={8}><TextField fullWidth label={t('location')} value={form.location} onChange={updateForm('location')} /></Grid><Grid item xs={12} md={4}><Button fullWidth sx={{ height: '100%' }} variant="outlined" startIcon={<MyLocation />} onClick={locate}>{t('useLocation')}</Button></Grid>
      <Grid item xs={6}><TextField fullWidth label="Latitude" value={form.latitude} onChange={updateForm('latitude')} /></Grid><Grid item xs={6}><TextField fullWidth label="Longitude" value={form.longitude} onChange={updateForm('longitude')} /></Grid>
      <Grid item xs={12}><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}><Button variant="outlined" disabled={busy} startIcon={<Psychology />} onClick={analyze}>Analyze with AI</Button><Button type="submit" disabled={busy || validationBusy || !['valid', 'review_required'].includes(imageValidation?.status)} variant="contained" size="large">{validationBusy ? 'Validating image…' : busy ? 'Working…' : 'Submit complaint'}</Button></Stack></Grid></Grid></Box></CardContent>
    </Card></Grid><Grid item xs={12} lg={5}><Stack spacing={3}><AiCard analysis={analysis} /><Card sx={{ borderRadius: 4 }}><CardContent><Stack direction="row" spacing={1} alignItems="center"><AddLocationAlt color="primary" /><Typography fontWeight={750}>{t('locationPreview')}</Typography></Stack><Box sx={{ mt: 2, height: 250, borderRadius: 3, overflow: 'hidden', bgcolor: 'action.hover' }}><iframe title="Selected complaint location" src={mapSource} width="100%" height="100%" style={{ border: 0 }} loading="lazy" referrerPolicy="no-referrer-when-downgrade" /></Box><Typography variant="caption" color="text.secondary" display="block" mt={1}>{form.latitude ? `${form.latitude}, ${form.longitude}` : t('mapHelp')}</Typography></CardContent></Card><Card sx={{ borderRadius: 4 }}><CardContent><Stack direction="row" spacing={1} alignItems="center"><Warning color="primary" /><Typography fontWeight={750}>India emergency contacts</Typography></Stack>{emergencyContacts.length ? <Stack spacing={1.25} mt={2}>{emergencyContacts.slice(0, 6).map(contact => <Box key={`${contact.service}-${contact.number}`} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.25 }}><Stack direction="row" justifyContent="space-between" alignItems="center"><Typography fontWeight={700}>{contact.service}</Typography><Typography color="primary.main" fontWeight={800}>{contact.number}</Typography></Stack><Typography variant="body2" color="text.secondary">{contact.description}</Typography><Stack direction="row" spacing={1} mt={1}>{contactSupports(contact, 'call') && contactNumber(contact) && <Button size="small" variant="contained" component="a" href={`tel:${contactNumber(contact)}`}>Call</Button>}{contactSupports(contact, 'sms') && contactNumber(contact) && <Button size="small" variant="outlined" component="a" href={contactSmsHref(contact, `Emergency request: ${contact.category || contact.service}. Please provide your location and details.`)}>SMS</Button>}</Stack></Box>)}</Stack> : <Typography color="text.secondary" variant="body2" mt={2}>Loading emergency contacts…</Typography>}</CardContent></Card></Stack></Grid></Grid>
    <Card id="history" sx={{ borderRadius: 4, mt: 3 }}><CardContent><Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between" mb={2}><Box><Typography variant="h6" fontWeight={750}>{t('complaintHistoryTitle')}</Typography><Typography variant="body2" color="text.secondary">{t('complaintHistoryHelp')}</Typography></Box><Stack direction="row" spacing={1}><TextField size="small" placeholder={t('search')} value={query} onChange={e => setQuery(e.target.value)} /><Select size="small" value={sort} onChange={e => setSort(e.target.value)}><MenuItem value="newest">{t('newest')}</MenuItem><MenuItem value="priority">{t('highest')}</MenuItem></Select></Stack></Stack><Grid container spacing={2}>{filtered.length ? filtered.map(c => <Grid item xs={12} md={6} key={c.id}><Card variant="outlined" sx={{ borderRadius: 3 }}><CardContent><Stack direction="row" justifyContent="space-between" gap={1}><Typography fontWeight={750}>{c.title}</Typography><PriorityChip value={c.priority} /></Stack><Typography variant="body2" color="text.secondary" mt={1}>{c.category} · {c.location || t('locationPending')}</Typography><Typography variant="caption" color="text.secondary" display="block" mt={0.5}>{c.created_at ? t('filedOn', { date: formatDisplayDate(c.created_at) }) : ''}</Typography>{c.updated_at ? <Typography variant="caption" color="text.secondary" display="block">{t('updatedOn', { date: formatDisplayDate(c.updated_at) })}</Typography> : null}<Typography variant="body2" mt={1} noWrap>{c.description}</Typography>
{(c.extension_requests || []).filter(request => request.status === 'Pending').map(request => <Alert key={request.id} severity="info" sx={{ mt: 1 }}><Typography fontWeight={700}>{request.official_name || 'Assigned official'} asks for {request.requested_hours} more hours</Typography><Typography variant="body2" sx={{ my: 1 }}>{request.reason}</Typography><Stack direction="row" spacing={1}><Button size="small" variant="contained" onClick={() => decideExtensionRequest(c, request, 'approve')}>Approve time</Button><Button size="small" color="error" variant="outlined" onClick={() => decideExtensionRequest(c, request, 'decline')}>Decline</Button></Stack></Alert>)}
{(c.extension_requests || []).filter(request => request.status !== 'Pending').slice(0, 1).map(request => <Alert key={request.id} severity={request.status === 'Approved' ? 'success' : 'warning'} sx={{ mt: 1 }}>Time-extension request {request.status.toLowerCase()}{request.status === 'Approved' ? `; deadline is now ${formatDisplayDate(c.sla_due_at)}` : ''}.</Alert>)}
{(c.completion_images || []).length > 0 && <Stack direction="row" spacing={1} mt={2}>{(c.completion_images || []).slice(0,3).map((img,i) => <AuthenticatedImage key={i} url={img.url || img} alt={`evidence-${i}`} style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 6 }} />)}</Stack>}
{c.emergency_contact && <Box mt={2} p={1.5} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}><Typography variant="caption" color="text.secondary" display="block" mb={1}>Emergency support for {c.category}</Typography><Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}><Box><Typography variant="caption" fontWeight={700}>{c.emergency_contact.service}</Typography><Typography variant="caption" color="text.secondary" display="block">{c.emergency_contact.number}</Typography></Box><Stack direction="row" spacing={1}>{contactSupports(c.emergency_contact, 'call') && contactNumber(c.emergency_contact) && <Button size="small" variant="contained" component="a" href={`tel:${contactNumber(c.emergency_contact)}`}>Call</Button>}{contactSupports(c.emergency_contact, 'sms') && contactNumber(c.emergency_contact) && <Button size="small" variant="outlined" component="a" href={contactSmsHref(c.emergency_contact, `Emergency request: ${c.category}. Location: ${c.location || 'Please add location'}. ${c.description || ''}`)}>SMS</Button>}</Stack></Stack></Box>}
<Stack direction="row" alignItems="center" justifyContent="space-between" mt={2}><StatusChip value={c.status} /><Stack direction="row" spacing={1}><Button size="small" startIcon={<Download />} onClick={() => receipt(c)}>{t('receipt')}</Button>{['Submitted', 'Accepted', 'Completed', 'Resolved'].includes(c.status) && <Button size="small" color="error" startIcon={<Delete />} onClick={() => deleteComplaint(c)}>Delete</Button>}</Stack></Stack><ComplaintTimeline status={c.status} /></CardContent></Card></Grid>) : <Grid item xs={12}><Typography color="text.secondary">{t('noComplaints')}</Typography></Grid>}</Grid></CardContent></Card>
    <Snackbar open={!!notice} autoHideDuration={5000} onClose={() => setNotice(null)}><Alert severity={notice?.type || 'info'} onClose={() => setNotice(null)}>{notice?.text}</Alert></Snackbar>
  </Box>;
}

function AiCard({ analysis }) { return <Card sx={{ borderRadius: 4, background: 'linear-gradient(135deg, rgba(25,118,210,.12), rgba(103,58,183,.16))' }}><CardContent><Stack direction="row" spacing={1} alignItems="center"><Psychology color="primary" /><Typography fontWeight={750}>AI assessment</Typography></Stack>{analysis ? <Box mt={2}><Stack direction="row" gap={1} flexWrap="wrap"><PriorityChip value={analysis.priority} /><Chip label={`${analysis.confidence}% confidence`} /></Stack><Typography mt={2}><b>{analysis.category}</b> detected · severity {analysis.severity}/100</Typography><Typography variant="body2" color="text.secondary" mt={1}>Keywords: {analysis.keywords?.join(', ') || 'No strong signals'}</Typography><LinearProgress color={priorityColors[analysis.priority] || 'primary'} variant="determinate" value={analysis.severity} sx={{ mt: 2, borderRadius: 3 }} /></Box> : <Typography color="text.secondary" variant="body2" mt={2}>Add a description and select “Analyze with AI” to receive a transparent, on-device-ready recommendation.</Typography>}</CardContent></Card> }
function ComplaintTimeline({ status }) { const current = Math.max(0, statusSteps.findIndex(s => s.toLowerCase() === (status || '').toLowerCase())); return <Stack direction="row" mt={2} spacing={.5} title="Complaint timeline">{statusSteps.map((step, index) => <Box key={step} sx={{ flex: 1, height: 5, borderRadius: 3, bgcolor: index <= current ? 'primary.main' : 'action.disabledBackground' }} />)}</Stack> }
function EvidenceAudit({ complaint }) { const evidence = complaint.completion_images || []; const history = complaint.history || []; return <Box sx={{ minWidth: 240, maxWidth: 380 }}><Typography variant="caption" fontWeight={700}>Admin audit trail</Typography><Typography variant="caption" color="text.secondary" display="block">{history.length} status updates · {evidence.length} phase photos</Typography>{evidence.length ? <Stack direction="row" spacing={1} mt={1} flexWrap="wrap">{evidence.map((image) => <Button key={image.id || image.url} size="small" component={AuthenticatedAssetLink} url={image.url || image} target="_blank" rel="noreferrer">{image.phase || 'Update'} photo</Button>)}</Stack> : <Typography variant="caption" color="text.secondary" display="block">No photo evidence uploaded yet.</Typography>}</Box> }
function RoleDashboard({ user, complaints, dashboard, reload, logout }) { const [status, setStatus] = useState('In Progress'); const [notice, setNotice] = useState(null); const update = async id => { try { await api.put(`/complaints/${id}/update`, { statusId: status === 'Resolved' ? 3 : 2, remarks: `Status updated to ${status}` }); setNotice('Complaint updated.'); reload(); } catch (error) { setNotice(error.message); } }; return <Box sx={{ py: 3 }}><Stack direction="row" justifyContent="space-between" alignItems="center" mb={3}><Box><Typography variant="h4" fontWeight={800}>{user.role === 'admin' ? 'Command center' : 'Official workspace'}</Typography><Typography color="text.secondary">Prioritize public-service actions with clear, AI-assisted context.</Typography></Box><Stack direction="row" spacing={1}>{user.role === 'admin' && <Button onClick={() => window.location.assign('/training')} startIcon={<Psychology />}>AI training</Button>}<Button onClick={logout} startIcon={<Logout />}>Sign out</Button></Stack></Stack><Grid container spacing={2} mb={3}>{[['Cases', complaints.length], ['Critical', complaints.filter(c => c.priority === 'Critical').length], ['Pending officials', dashboard.pendingOfficials?.length || 0], ['Departments', dashboard.departments?.length || 0]].map(([label,val]) => <Grid item xs={6} md={3} key={label}><Card sx={{ borderRadius: 4 }}><CardContent><Typography color="text.secondary">{label}</Typography><Typography variant="h4" fontWeight={800}>{val}</Typography></CardContent></Card></Grid>)}</Grid><Card sx={{ borderRadius: 4 }}><CardContent><Typography variant="h6" fontWeight={750} mb={2}>{user.role === 'admin' ? 'System complaints' : 'Assigned complaints'}</Typography>{complaints.map(c => <Card key={c.id} variant="outlined" sx={{ p: 2, mb: 1, borderRadius: 3 }}><Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}><Box><Typography fontWeight={700}>{c.title}</Typography><Typography variant="body2" color="text.secondary">{c.category} · {c.location}</Typography><Stack direction="row" gap={1} mt={1}><PriorityChip value={c.priority} /><StatusChip value={c.status} /></Stack></Box>{user.role === 'admin' && <EvidenceAudit complaint={c} />}{user.role === 'official' && <Stack direction="row" spacing={1}><Select size="small" value={status} onChange={e => setStatus(e.target.value)}><MenuItem value="In Progress">Work started</MenuItem><MenuItem value="Resolved">Completed</MenuItem></Select><Button variant="contained" onClick={() => update(c.id)}>Update</Button></Stack>}</Stack></Card>)}{!complaints.length && <Typography color="text.secondary">No cases are available yet.</Typography>}</CardContent></Card><Snackbar open={!!notice} autoHideDuration={4000} onClose={() => setNotice(null)} message={notice} /></Box> }
