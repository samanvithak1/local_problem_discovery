import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, Select, Snackbar, Stack, TextField, Typography, FormControl, InputLabel } from '@mui/material';
import {
  Analytics,
  Assignment,
  Campaign,
  CheckCircle,
  Engineering,
  Language,
  Logout,
  Map,
  NotificationsActive,
  Person,
  Phone,
  Route,
  Settings,
  TaskAlt,
  Warning,
  Speed,
  Home,
  Report,
  Timeline,
  CloudUpload,
  Delete,
  KeyboardArrowRight,
  InfoOutlined,
} from '@mui/icons-material';
import { motion } from 'framer-motion';
import { Doughnut, Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import api, { dialNumber } from '../services/api';
import { AuthenticatedAssetLink, AuthenticatedImage } from '../components/AuthenticatedAsset';
import { useTranslation } from 'react-i18next';
import { CIVIC_CATEGORIES, findCategoryMention } from '../constants/civicCategories';

ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

const priorityColors = { Critical: 'bg-rose-500/20 text-rose-200 border-rose-400/40', High: 'bg-amber-500/20 text-amber-200 border-amber-400/40', Medium: 'bg-sky-500/20 text-sky-200 border-sky-400/40', Low: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40' };
const statusColors = { Submitted: 'bg-slate-500/20 text-slate-200', 'In Progress': 'bg-cyan-500/20 text-cyan-200', Completed: 'bg-emerald-500/20 text-emerald-200', Resolved: 'bg-emerald-500/20 text-emerald-200', Accepted: 'bg-indigo-500/20 text-indigo-200', Assigned: 'bg-violet-500/20 text-violet-200', Escalated: 'bg-rose-500/20 text-rose-200', Rejected: 'bg-rose-500/20 text-rose-200' };
const priorityOrder = { Critical: 4, High: 3, Medium: 2, Low: 1, '': 0 };

function formatTime(date) {
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function deadlineLabel(value) {
  if (!value) return 'Deadline not set';
  const difference = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(difference)) return 'Deadline not set';
  const hours = Math.ceil(Math.abs(difference) / 3600000);
  if (difference < 0) return `Overdue by ${hours}h`;
  return `${hours}h remaining`;
}

export default function OfficialDashboard({ user, complaints, dashboard, reload, logout }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('dashboard');
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState(null);
  const [language, setLanguage] = useState('English');
  const [timePeriods, setTimePeriods] = useState({});
  const [extensionItem, setExtensionItem] = useState(null);
  const [extensionHours, setExtensionHours] = useState('24');
  const [extensionReason, setExtensionReason] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All categories');
  const navItems = [
    ['dashboard', t('dashboard'), Home],
    ['complaints', t('assignedComplaints'), Assignment],
    ['emergency', t('emergencyAlerts'), Warning],
    ['map', t('complaintMap'), Map],
    ['analytics', t('aiAnalytics'), Analytics],
    ['tasks', t('taskManagement'), TaskAlt],
    ['visits', t('fieldVisits'), Route],
    ['notifications', t('notifications'), NotificationsActive],
    ['reports', t('reports'), Report],
    ['profile', t('profile'), Person],
    ['settings', t('settings'), Settings],
  ];
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const official = dashboard?.official || dashboard?.profile || {};
  const complaintList = useMemo(() => {
    if (!Array.isArray(complaints)) return [];
    return [...complaints].sort((a, b) => {
      const scoreDiff = (b.priority_score || 0) - (a.priority_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const priorityDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
  }, [complaints]);

  const critical = complaintList.filter((item) => item.priority === 'Critical');
  const pending = complaintList.filter((item) => item.status === 'Submitted' || item.status === 'Pending');
  const progress = complaintList.filter((item) => item.status === 'In Progress' || item.status === 'Assigned');
  const completed = complaintList.filter((item) => ['Resolved', 'Completed', 'Closed'].includes(item.status)).length;
  const categoryFilteredComplaints = categoryFilter === 'All categories' ? complaintList : complaintList.filter(item => item.category === categoryFilter);
  const averageResolution = completed ? 'Completed cases tracked' : 'No completed cases';

  useEffect(() => {
    if (!selected && complaintList.length) setSelected(complaintList[0]);
  }, [complaintList, selected]);

  useEffect(() => {
    setTimePeriods(current => {
      let changed = false;
      const next = { ...current };
      complaintList.forEach(item => {
        if (item.sla_target_hours && Number(next[item.id]) !== item.sla_target_hours) {
          next[item.id] = String(item.sla_target_hours);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [complaintList]);

  const update = async (item, action, statusName = null, remarks = null) => {
    try {
      const payload = { action, remarks: remarks || `Official action: ${action}` };
      if (statusName) payload.statusName = statusName;
      await api.put(`/complaints/${item.id}/update`, payload);
      setNotice(`#${item.id}: ${action}. Citizen notification queued.`);
      reload();
    } catch (error) {
      const msg = error?.response?.data?.message || error?.message || 'Unable to update complaint.';
      setNotice(msg);
    }
  };

  const saveResolutionTarget = async (item, value) => {
    const targetHours = Number(value);
    setTimePeriods(current => ({ ...current, [item.id]: String(targetHours) }));
    try {
      await api.put(`/official/complaints/${item.id}/target`, { targetHours });
      setNotice(`#${item.id}: ${targetHours}-hour target saved. The deadline starts now.`);
      reload();
    } catch (error) {
      setTimePeriods(current => { const next = { ...current }; delete next[item.id]; return next; });
      setNotice(error?.response?.data?.message || 'Unable to save the resolution target.');
      reload();
    }
  };

  const submitExtensionRequest = async () => {
    if (!extensionItem) return;
    try {
      await api.post(`/official/complaints/${extensionItem.id}/extension-requests`, {
        requestedHours: Number(extensionHours), reason: extensionReason.trim(),
      });
      setNotice(`#${extensionItem.id}: time-extension request sent to the citizen and administrator.`);
      setExtensionItem(null); setExtensionReason(''); reload();
    } catch (error) {
      setNotice(error?.response?.data?.message || 'Unable to send the time-extension request.');
    }
  };

  const deleteComplaint = async (item) => {
    if (!window.confirm(`Delete complaint #${item.id}? This cannot be undone.`)) return;
    try {
      await api.delete(`/complaints/${item.id}`);
      setNotice(`#${item.id}: complaint deleted.`);
      reload();
    } catch (error) {
      setNotice(error?.response?.data?.message || error?.message || 'Unable to delete complaint.');
    }
  };

  const downloadReport = (period) => {
    const rows = [
      ['SMART CIVIC AI OFFICIAL REPORT'],
      [`Report period: ${period}`],
      [`Generated: ${new Date().toLocaleString('en-IN')}`],
      [],
      ['Case ID', 'Title', 'Category', 'Priority', 'Status', 'Location', 'Filed at'],
      ...complaintList.map((item) => [item.id, item.title, item.category, item.priority, item.status, item.location, item.created_at]),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${period.toLowerCase().replaceAll(' ', '-')}-official-report.csv`; link.click(); URL.revokeObjectURL(url);
    setNotice(`${period} report downloaded.`);
  };

  const uploadPhasePhoto = async (item, file) => {
    if (!file) return;
    try {
      const formData = new FormData();
      const phase = item.status || 'Submitted';
      formData.append('statusName', phase);
      formData.append('remarks', `${phase} photo uploaded by official.`);
      formData.append('mediaFile', file);
      await api.post(`/complaints/${item.id}/progress`, formData);
      setNotice(`#${item.id}: ${phase.toLowerCase()} evidence uploaded.`);
      reload();
    } catch (error) {
      const msg = error?.response?.data?.message || error?.message || 'Unable to upload progress photo.';
      setNotice(msg);
    }
  };

  const destination = selected?.latitude && selected?.longitude ? `${selected.latitude},${selected.longitude}` : selected?.location || 'Karnataka, India';

  const statusCards = [
    ['Assigned', complaintList.length, Assignment, 'from-cyan-500/20 via-cyan-600/10 to-slate-900'],
    ['Critical', critical.length, Warning, 'from-rose-500/20 via-rose-600/10 to-slate-900'],
    ['Pending', pending.length, Campaign, 'from-amber-500/20 via-amber-600/10 to-slate-900'],
    ['In Progress', progress.length, Engineering, 'from-violet-500/20 via-violet-600/10 to-slate-900'],
    ['Completed', completed, CheckCircle, 'from-emerald-500/20 via-emerald-600/10 to-slate-900'],
    ['Today Alerts', critical.length, NotificationsActive, 'from-rose-500/20 via-orange-500/10 to-slate-900'],
    ['Avg. Resolve', averageResolution, Route, 'from-sky-500/20 via-sky-600/10 to-slate-900'],
  ];

  const categoryCounts = complaintList.reduce((counts, item) => ({ ...counts, [item.category || 'Other']: (counts[item.category || 'Other'] || 0) + 1 }), {});
  const locationCounts = complaintList.reduce((counts, item) => ({ ...counts, [item.location || 'Unspecified']: (counts[item.location || 'Unspecified'] || 0) + 1 }), {});
  const doughnutData = { labels: Object.keys(categoryCounts).length ? Object.keys(categoryCounts) : ['No assigned complaints'], datasets: [{ data: Object.keys(categoryCounts).length ? Object.values(categoryCounts) : [1], backgroundColor: ['#22d3ee', '#f59e0b', '#8b5cf6', '#f43f5e', '#14b8a6', '#fb7185'] }] };
  const lineData = { labels: complaintList.slice(0, 8).reverse().map((item) => `#${item.id}`), datasets: [{ label: 'Priority score', data: complaintList.slice(0, 8).reverse().map((item) => item.priority_score || 0), borderColor: '#2dd4bf', backgroundColor: 'rgba(45,212,191,0.15)', tension: 0.35, fill: true }] };
  const barData = { labels: Object.keys(locationCounts).slice(0, 6).length ? Object.keys(locationCounts).slice(0, 6) : ['No assigned complaints'], datasets: [{ label: 'Complaints', data: Object.keys(locationCounts).length ? Object.values(locationCounts).slice(0, 6) : [0], backgroundColor: ['#3b82f6', '#8b5cf6', '#14b8a6', '#f59e0b', '#fb7185', '#22d3ee'] }] };

  const complaintListView = (items) => (
    <div className="grid gap-4 xl:grid-cols-2">
      {!items.length && <div className="xl:col-span-2 rounded-[28px] border border-dashed border-slate-600 bg-slate-900/70 p-8 text-center"><Warning className="text-cyan-300" /><Typography className="!mt-3 !text-lg !font-semibold !text-white">No cases in this queue</Typography><Typography className="!mt-1 !text-sm !text-slate-400">New assigned or emergency complaints will appear here automatically.</Typography></div>}
      {items.map((item) => (
        <motion.div key={item.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="rounded-[24px] border border-slate-700/80 bg-slate-900/80 p-4 shadow-[0_18px_50px_rgba(15,23,42,0.38)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Typography className="!text-xs !font-semibold !tracking-[0.12em] !text-cyan-300"># {item.id}</Typography>
                <Chip label={item.category || 'Service issue'} size="small" className="!bg-slate-800 !text-slate-200" />
                <Chip label={item.department_name || 'Municipal'} size="small" className="!bg-cyan-500/10 !text-cyan-200" />
              </div>
              <Typography className="!mt-2 !text-lg !font-semibold !text-white">{item.title}</Typography>
              <Typography className="!mt-1 !text-sm !text-slate-300 line-clamp-3">{item.description}</Typography>
            </div>
            <div className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${priorityColors[item.priority] || priorityColors.Medium}`}>
              {item.priority || 'Medium'}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <div className={`rounded-full px-2.5 py-1 text-[11px] ${statusColors[item.status] || statusColors.Submitted}`}>
              {item.status || 'Submitted'}
            </div>
            <div className="rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] text-slate-200">Citizen: {item.citizen_name || 'Citizen'}</div>
            {item.priority_score ? <div className="rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] text-slate-200">Impact score: {item.priority_score}/100</div> : null}
            <div className={`rounded-full px-2.5 py-1 text-[11px] ${item.ai_confidence == null || item.ai_confidence < 70 ? 'bg-amber-500/20 text-amber-200' : 'bg-slate-800/80 text-slate-200'}`}>{item.ai_category ? `${item.ai_confidence == null ? 'AI visual match - verify photo' : item.ai_confidence < 70 ? 'AI tentative' : 'AI category'}: ${item.ai_category}${item.ai_confidence != null ? ` · ${Number(item.ai_confidence).toFixed(2)}%` : ''}${item.ai_confidence != null && item.ai_confidence < 70 ? ' · verify photo' : ''}` : 'AI did not confirm category · review photo'}</div>
            {findCategoryMention(`${item.title || ''} ${item.description || ''}`, item.category) && <div className="rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] text-amber-200">Report text mentions {findCategoryMention(`${item.title || ''} ${item.description || ''}`, item.category)} · selected {item.category} · verify category</div>}
            <div className="rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] text-slate-200">{item.location || 'Location pending'}</div>
            <div className={`rounded-full px-2.5 py-1 text-[11px] ${item.sla_due_at && new Date(item.sla_due_at) < new Date() ? 'bg-rose-500/20 text-rose-200' : 'bg-emerald-500/20 text-emerald-200'}`}>Resolution deadline: {deadlineLabel(item.sla_due_at)}</div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Select size="small" value={String(timePeriods[item.id] || item.sla_target_hours || '24')} disabled={Boolean(item.escalated_at)} onChange={(event) => saveResolutionTarget(item, event.target.value)} className="!min-w-[150px] !bg-slate-800 !text-slate-100"><MenuItem value="1">Target: 1 hour</MenuItem><MenuItem value="2">Target: 2 hours</MenuItem><MenuItem value="4">Target: 4 hours</MenuItem><MenuItem value="8">Target: 8 hours</MenuItem><MenuItem value="12">Target: 12 hours</MenuItem><MenuItem value="24">Target: 24 hours</MenuItem><MenuItem value="48">Target: 48 hours</MenuItem><MenuItem value="72">Target: 72 hours</MenuItem><MenuItem value="168">Target: 7 days</MenuItem><MenuItem value="336">Target: 14 days</MenuItem><MenuItem value="720">Target: 30 days</MenuItem></Select>
            <Button size="small" onClick={() => { setSelected(item); setTab('map'); }} className="!rounded-full !border !border-slate-600 !text-slate-200">View details</Button>
            <Button size="small" variant="outlined" onClick={() => update(item, 'accept', 'Accepted', 'Complaint accepted by official for review.')} className="!rounded-full">Accept</Button>
            <Button size="small" variant="outlined" color="error" onClick={() => update(item, 'reject', 'Rejected', 'Complaint rejected by official.')} className="!rounded-full">Reject</Button>
            <Button size="small" variant="contained" onClick={() => update(item, 'progress', 'In Progress', 'Official started working on the complaint.')} className="!rounded-full !bg-cyan-600 hover:!bg-cyan-500">Start work</Button>
            <Button size="small" variant="contained" color="success" onClick={() => update(item, 'resolve', 'Resolved', 'Complaint resolved by official.')} className="!rounded-full">Resolve</Button>
            {!['Resolved', 'Completed', 'Closed', 'Rejected'].includes(item.status) && !item.escalated_at && !(item.extension_requests || []).some(request => request.status === 'Pending') && <Button size="small" variant="outlined" color="warning" onClick={() => { setExtensionItem(item); setExtensionHours('24'); setExtensionReason(''); }} className="!rounded-full">Ask citizen for more time</Button>}
            {['Submitted', 'Accepted', 'Completed', 'Resolved'].includes(item.status) && <Button size="small" color="error" startIcon={<Delete />} onClick={() => deleteComplaint(item)} className="!rounded-full">Delete</Button>}
            <Button size="small" component="label" className="!rounded-full !bg-slate-800 !text-slate-100">Upload {item.status || 'Submitted'} photo<input hidden type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) { uploadPhasePhoto(item, file); event.target.value = ''; } }} /></Button>
            <Button size="small" startIcon={<Route />} onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(item.latitude && item.longitude ? `${item.latitude},${item.longitude}` : item.location || '')}`, '_blank', 'noopener,noreferrer')} className="!rounded-full">Navigate</Button>
            {item.citizen_phone ? <Button size="small" startIcon={<Phone />} component="a" href={`tel:${String(item.citizen_phone).replace(/[^0-9+]/g, '')}`} className="!rounded-full">Call</Button> : null}
          </div>
          {(item.extension_requests || []).slice(0, 2).map((request) => <Alert key={request.id} severity={request.status === 'Pending' ? 'info' : request.status === 'Approved' ? 'success' : 'warning'} sx={{ mt: 1 }}>
            Extra time: {request.status.toLowerCase()} · {request.requested_hours}h requested{request.reason ? ` · ${request.reason}` : ''}
          </Alert>)}
          {(item.completion_images || []).length > 0 && <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">{item.completion_images.map((image) => <AuthenticatedAssetLink key={image.id || image.url} url={image.url || image} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border border-slate-600 hover:border-cyan-400"><AuthenticatedImage url={image.url || image} alt={`${image.phase || 'Progress'} evidence`} className="h-16 w-20 object-cover" /><span className="block px-2 py-1">{image.phase || 'Progress'} photo</span></AuthenticatedAssetLink>)}</div>}
          <div className="mt-3 border-t border-slate-700 pt-3"><Typography className="!text-xs !font-semibold !text-slate-300">Case timeline</Typography>{(item.history || []).length ? <div className="mt-2 space-y-1">{item.history.slice(-5).reverse().map((entry) => <div key={entry.id} className="text-xs text-slate-400"><span className="font-semibold text-cyan-300">{entry.status_name}</span> · {entry.note || 'Updated'} · {entry.created_at ? formatTime(new Date(entry.created_at)) : ''}</div>)}</div> : <Typography className="!mt-1 !text-xs !text-slate-500">No progress entries yet.</Typography>}</div>
        </motion.div>
      ))}
    </div>
  );

  const homeView = (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statusCards.map(([label, value, Icon, gradient]) => (
          <motion.div key={label} whileHover={{ y: -4, scale: 1.01 }} className={`rounded-3xl border border-slate-700/80 bg-gradient-to-br ${gradient} p-4 shadow-[0_20px_60px_rgba(0,0,0,0.2)]`}>
            <div className="flex items-center justify-between">
              <div>
                <Typography className="!text-sm !font-semibold !text-slate-300">{label}</Typography>
                <Typography className="!mt-2 !text-3xl !font-bold !text-white">{value}</Typography>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-2 text-cyan-200">
                <Icon fontSize="medium" />
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="rounded-[28px] border border-rose-500/30 bg-gradient-to-br from-rose-600/20 via-rose-500/10 to-slate-900/80 p-5 shadow-[0_20px_60px_rgba(220,80,80,0.18)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-rose-200">
              <Warning />
              <Typography className="!text-lg !font-semibold">EMERGENCY ALERT</Typography>
            </div>
            <Typography className="!mt-2 !text-white">#{critical[0]?.id || '1001'} · {critical[0]?.category || 'Road Damage'} · {critical[0]?.location || 'Hebbal, Bengaluru'}</Typography>
            <Typography className="!mt-1 !text-sm !text-slate-300">AI priority model flagged this as critical due to heavy traffic, nearby hospital, and 125 similar past complaints.</Typography>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="contained" color="error" onClick={() => update(critical[0] || complaintList[0], 'accept', 'Accepted', 'Emergency complaint accepted by official.')} className="!rounded-full">Accept</Button>
            <Button variant="outlined" onClick={() => { setSelected(critical[0] || complaintList[0]); setTab('map'); }} className="!rounded-full">Navigate</Button>
            <Button variant="contained" onClick={() => update(critical[0] || complaintList[0], 'progress', 'In Progress', 'Official started emergency response work.')} className="!rounded-full !bg-cyan-600 hover:!bg-cyan-500">Start work</Button>
          </div>
        </div>
      </motion.div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between">
            <Typography className="!text-lg !font-semibold !text-white">{t('assignedComplaints')}</Typography>
            <Typography className="!text-sm !text-slate-400">{t('complaintHistoryHelp')}</Typography>
          </div>
          {complaintListView(complaintList)}
        </div>
        <div className="space-y-4">
          <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
            <Typography className="!text-lg !font-semibold !text-white">{t('aiAnalytics')}</Typography>
            <div className="mt-4 h-56">
              <Doughnut data={doughnutData} options={{ plugins: { legend: { labels: { color: '#e2e8f0' } } }, cutout: '70%' }} />
            </div>
          </div>
          <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
            <Typography className="!text-lg !font-semibold !text-white">{t('reports')}</Typography>
            <div className="mt-4 h-40">
              <Line data={lineData} options={{ plugins: { legend: { labels: { color: '#e2e8f0' } } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const mapView = (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
        <div className="mb-3 flex items-center justify-between">
          <Typography className="!text-lg !font-semibold !text-white">{t('complaintMap')}</Typography>
          <Chip label="Live route preview" size="small" className="!bg-cyan-500/20 !text-cyan-200" />
        </div>
        <div className="overflow-hidden rounded-3xl border border-slate-700/80">
          <iframe title="Official map" src={`https://www.google.com/maps?q=${encodeURIComponent(destination)}&z=14&output=embed`} width="100%" height="480" style={{ border: 0 }} loading="lazy" />
        </div>
      </div>
      <div className="space-y-4">
        <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
          <Typography className="!text-lg !font-semibold !text-white">{selected?.title || 'Select a complaint'}</Typography>
          <Typography className="!mt-2 !text-sm !text-slate-300">{selected?.location || 'Hebbal, Bengaluru'}</Typography>
          <div className="mt-3 flex flex-wrap gap-2">
            <div className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${priorityColors[selected?.priority] || priorityColors.Medium}`}>
              {selected?.priority || 'High'}
            </div>
            <div className="rounded-full bg-cyan-500/20 px-2.5 py-1 text-xs font-semibold text-cyan-200">ETA 16 min</div>
          </div>
          <div className="mt-4 space-y-2 text-sm text-slate-300">
            <div className="flex items-center justify-between rounded-2xl bg-slate-800/80 px-3 py-2"><span>Nearby complaints</span><span>3 active</span></div>
            <div className="flex items-center justify-between rounded-2xl bg-slate-800/80 px-3 py-2"><span>Traffic layer</span><span>Moderate</span></div>
            <div className="flex items-center justify-between rounded-2xl bg-slate-800/80 px-3 py-2"><span>Distance from official</span><span>3.2 km</span></div>
          </div>
          <Button fullWidth variant="contained" startIcon={<Route />} onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`, '_blank', 'noopener,noreferrer')} className="!mt-4 !rounded-full !bg-cyan-600 hover:!bg-cyan-500">Open navigation</Button>
        </div>
        <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
          <Typography className="!text-lg !font-semibold !text-white">{t('taskManagement')}</Typography>
          <div className="mt-3 h-40">
            <Bar data={barData} options={{ plugins: { legend: { labels: { color: '#e2e8f0' } } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }} />
          </div>
        </div>
      </div>
    </div>
  );

  const analyticsView = (
    <div className="grid gap-4 lg:grid-cols-2">
      {[
        ['Priority Distribution', doughnutData, true],
        ['Monthly Trends', lineData, false],
        ['Department Performance', barData, false],
        ['Top Problem Areas', doughnutData, false],
      ].map(([title, data, isDoughnut]) => (
        <div key={title} className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
          <Typography className="!text-lg !font-semibold !text-white">{title}</Typography>
          <div className="mt-4 h-56">
            {isDoughnut ? <Doughnut data={data} options={{ plugins: { legend: { labels: { color: '#e2e8f0' } } }, cutout: '70%' }} /> : <Bar data={data} options={{ plugins: { legend: { labels: { color: '#e2e8f0' } } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }} />}
          </div>
        </div>
      ))}
    </div>
  );

  const emergencyView = (
    <div className="space-y-4">
      <div className="rounded-[28px] border border-rose-500/30 bg-rose-500/10 p-5"><div className="flex items-center gap-2 text-rose-200"><Warning /><Typography className="!text-xl !font-semibold">Emergency alert queue</Typography></div><Typography className="!mt-2 !text-sm !text-slate-300">Critical cases require an acknowledgement, field action, and a status update.</Typography></div>
      {complaintListView(critical)}
    </div>
  );

  const taskView = (
    <div className="space-y-4"><div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-5"><Typography className="!text-xl !font-semibold !text-white">Task management</Typography><Typography className="!mt-1 !text-sm !text-slate-400">Start work, complete field tasks, and keep citizens informed from one queue.</Typography></div><div className="grid gap-3 lg:grid-cols-2">{complaintList.filter((item) => !['Resolved', 'Completed', 'Closed', 'Rejected'].includes(item.status)).map((item) => <div key={item.id} className="rounded-3xl border border-slate-700/80 bg-slate-900/70 p-4"><div className="flex items-start justify-between gap-3"><div><Typography className="!font-semibold !text-white">#{item.id} · {item.title}</Typography><Typography className="!mt-1 !text-sm !text-slate-400">{item.location} · {deadlineLabel(item.sla_due_at)}</Typography></div><Chip label={item.status || 'Submitted'} size="small" className="!bg-cyan-500/20 !text-cyan-100" /></div><div className="mt-4 flex flex-wrap gap-2"><Button size="small" variant="outlined" onClick={() => update(item, 'accept', 'Accepted', 'Field task acknowledged by official.')}>Acknowledge</Button><Button size="small" variant="contained" onClick={() => update(item, 'progress', 'In Progress', 'Field task started by official.')} className="!bg-cyan-600">Start task</Button><Button size="small" color="success" variant="contained" onClick={() => update(item, 'resolve', 'Resolved', 'Field task completed by official.')}>Complete</Button></div></div>)}{!complaintList.filter((item) => !['Resolved', 'Completed', 'Closed', 'Rejected'].includes(item.status)).length && <div className="rounded-3xl border border-dashed border-slate-600 p-8 text-center text-slate-400">No open tasks. All assigned work is complete.</div>}</div></div>
  );

  const sideContent = {
    dashboard: homeView,
    complaints: <div className="space-y-4"><FormControl size="small" sx={{ minWidth: 220 }}><InputLabel id="official-category-filter">Category</InputLabel><Select labelId="official-category-filter" label="Category" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value)}><MenuItem value="All categories">All categories</MenuItem>{CIVIC_CATEGORIES.map(category => <MenuItem key={category} value={category}>{category}</MenuItem>)}</Select></FormControl>{complaintListView(categoryFilteredComplaints)}</div>,
    emergency: emergencyView,
    map: mapView,
    analytics: analyticsView,
    tasks: taskView,
    visits: mapView,
    notifications: (
      <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
        <Typography className="!text-lg !font-semibold !text-white">Live notifications</Typography>
        <div className="mt-4 space-y-3">
        {(dashboard.notifications || []).length ? (dashboard.notifications || []).map((notification) => (
          <div key={notification.id} className="flex items-center gap-3 rounded-2xl border border-slate-700/80 bg-slate-800/70 p-3 text-sm text-slate-300">
            <NotificationsActive className="text-cyan-300" />
              <span>{notification.message}</span>
          </div>
        )) : <Typography className="!text-sm !text-slate-400">No notifications yet.</Typography>}
        </div>
      </div>
    ),
    reports: (
      <div className="grid gap-4 md:grid-cols-2">
        {['Daily Report', 'Weekly Report', 'Monthly Report', 'Department Report'].map((label) => (
          <div key={label} className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
            <Typography className="!text-lg !font-semibold !text-white">{label}</Typography>
            <Typography className="!mt-2 !text-sm !text-slate-300">Export as PDF, Excel, or CSV with the latest control-room metrics.</Typography>
            <Button variant="contained" onClick={() => downloadReport(label)} className="!mt-4 !rounded-full !bg-cyan-600 hover:!bg-cyan-500">Download CSV</Button>
          </div>
        ))}
      </div>
    ),
    profile: (
      <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
        <Typography className="!text-lg !font-semibold !text-white">Official profile</Typography>
        <div className="mt-4 grid gap-4 md:grid-cols-[0.7fr_1.3fr]">
          <div className="rounded-3xl bg-gradient-to-br from-cyan-600/20 to-slate-900 p-5">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 text-2xl font-semibold text-cyan-200">
              {((official.full_name || user?.name || 'SO').split(' ').map((part) => part[0]).slice(0, 2).join('') || 'SO').toUpperCase()}
            </div>
            <Typography className="!mt-4 !text-xl !font-semibold !text-white">{official.full_name || user?.name || 'Government Official'}</Typography>
            <Typography className="!mt-1 !text-sm !text-slate-300">{official.designation || 'Municipal Executive Officer'}</Typography>
          </div>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="rounded-2xl bg-slate-800/80 p-3">Department: {official.department?.name || 'Municipal Services'}</div>
            <div className="rounded-2xl bg-slate-800/80 p-3">Employee ID: {official.employee_id || 'MCD-2048'}</div>
            <div className="rounded-2xl bg-slate-800/80 p-3">Contact: {official.phone || '+91 98765 43210'}</div>
            <div className="rounded-2xl bg-slate-800/80 p-3">Office: {official.office_address || 'Town Hall, Bengaluru'}</div>
          </div>
        </div>
      </div>
    ),
    settings: (
      <div className="rounded-[28px] border border-slate-700/80 bg-slate-900/70 p-4 backdrop-blur-xl">
        <Typography className="!text-lg !font-semibold !text-white">{t('settings')}</Typography>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-700/80 bg-slate-800/70 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">{t('language')}</span>
              <Select value={language} onChange={(event) => setLanguage(event.target.value)} size="small" className="!min-w-[140px]">
                <MenuItem value="English">English</MenuItem>
                <MenuItem value="Kannada">Kannada</MenuItem>
              </Select>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-700/80 bg-slate-800/70 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">{t('soundAlerts')}</span>
              <Chip label={t('enabled')} size="small" className="!bg-emerald-500/20 !text-emerald-200" />
            </div>
          </div>
        </div>
      </div>
    ),
  };

  return (
    <div className="min-h-[calc(100vh-40px)] rounded-[28px] border border-slate-700/80 bg-slate-950/70 shadow-[0_25px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="flex min-h-[calc(100vh-40px)] flex-col lg:flex-row">
        <aside className="w-full border-b border-slate-700/80 bg-slate-900/80 p-3 lg:w-72 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2 rounded-2xl border border-cyan-400/20 bg-cyan-500/10 p-3">
            <Analytics className="text-cyan-300" />
            <div>
              <Typography className="!text-base !font-semibold !text-white">Smart Civic AI</Typography>
              <Typography className="!text-xs !text-slate-400">{t('commandCenter')}</Typography>
            </div>
          </div>
          <div className="mt-4 space-y-1">
            {navItems.map(([id, label, Icon]) => (
              <button key={id} onClick={() => setTab(id)} className={`flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition ${tab === id ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-300 hover:bg-slate-800/70'}`}>
                <span className="flex items-center gap-2"><Icon fontSize="small" />{label}</span>
                <KeyboardArrowRight fontSize="small" />
              </button>
            ))}
          </div>
          <div className="mt-6 rounded-2xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-200">
            <div className="flex items-center gap-2"><Warning fontSize="small" />{t('criticalQueueActive')}</div>
            <div className="mt-2 text-xs text-rose-100">{t('emergencyComplaintsNeedAttention', { count: critical.length })}</div>
          </div>
          <button onClick={logout} className="mt-6 flex w-full items-center gap-2 rounded-2xl bg-slate-800/70 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-700">
            <Logout fontSize="small" />Logout
          </button>
        </aside>

        <main className="flex-1 p-4 md:p-6">
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <Typography className="!text-3xl !font-semibold !text-white">{t('commandCenter')}</Typography>
              <Typography className="!text-sm !text-slate-400">{official.department?.name || 'Municipal Services'} • {formatTime(clock)}</Typography>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-200">
                <NotificationsActive fontSize="small" />{t('liveUpdates')}
              </div>
              <div className="flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-200">
                <Language fontSize="small" />{language}
              </div>
              <div className="flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-slate-200">
                <Person fontSize="small" />{official.full_name || user?.name || 'Official'}
              </div>
            </div>
          </div>

          {sideContent[tab]}
        </main>
      </div>
      <Snackbar open={!!notice} autoHideDuration={4500} onClose={() => setNotice(null)} message={notice || ''} />
      <Dialog open={Boolean(extensionItem)} onClose={() => setExtensionItem(null)} fullWidth maxWidth="sm">
        <DialogTitle>Ask the citizen for more time</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2, pt: '12px !important' }}>
          <Typography color="text.secondary">The current deadline remains active until the citizen approves. If it expires first, the case is escalated to the administrator.</Typography>
          <TextField select label="Additional time" value={extensionHours} onChange={(event) => setExtensionHours(event.target.value)}>
            {[1, 2, 4, 8, 12, 24, 48, 72, 168, 336, 720].map((hours) => <MenuItem key={hours} value={String(hours)}>{hours >= 24 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`}</MenuItem>)}
          </TextField>
          <TextField label="Message to the citizen" multiline minRows={3} value={extensionReason} onChange={(event) => setExtensionReason(event.target.value)} inputProps={{ maxLength: 512 }} helperText="Explain what is incomplete and why more time is needed." />
        </DialogContent>
        <DialogActions><Button onClick={() => setExtensionItem(null)}>Cancel</Button><Button variant="contained" disabled={extensionReason.trim().length < 8} onClick={submitExtensionRequest}>Send request</Button></DialogActions>
      </Dialog>
    </div>
  );
}
