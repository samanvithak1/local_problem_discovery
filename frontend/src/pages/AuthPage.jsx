import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Box, Button, Checkbox, Container, FormControlLabel, Grid, IconButton, InputAdornment, MenuItem, Paper, TextField, Typography, Alert } from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { useTranslation } from 'react-i18next';
import { FaUserCircle, FaLock, FaEnvelope, FaMapMarkerAlt, FaCalendarAlt } from 'react-icons/fa';
import { CIVIC_CATEGORIES } from '../constants/civicCategories';

const CATEGORY_DEPARTMENT_NAMES = {
  'Road Damage': 'Road Department',
  Garbage: 'Garbage/Waste Management Department',
  'Street Light': 'Street Light Department',
  'Water Leakage': 'Water Supply Department',
  Drainage: 'Drainage Department',
  Electricity: 'Electrical Department',
  'Tree Fallen': 'Tree/Public Works Department',
  'Illegal Dumping': 'Garbage/Waste Management Department',
  Flood: 'Drainage Department',
  Fire: 'Fire and Rescue Department',
  'Traffic Signal': 'Traffic Management Department',
  'Public Property Damage': 'Public Works Department',
  'Animal Issue': 'Animal Welfare Department',
  'Medical Emergency': 'Health and Ambulance Department',
};

const initUserState = {
  fullName: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
  state: '',
  district: '',
  taluk: '',
  village: '',
  address: '',
  employeeId: '',
  departmentId: '',
  departmentCategory: '',
  designation: '',
  officeAddress: '',
  identityCardUrl: '',
  adminId: '',
  department: '',
  setupKey: '',
};

export default function AuthPage() {
  const { t, i18n } = useTranslation();
  const { mode, role } = useParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [values, setValues] = useState(initUserState);
  useEffect(() => {
  if (mode !== 'login') return;

  const shouldRemember =
    localStorage.getItem('ai_remember_email') === 'true';
  const savedEmail = localStorage.getItem('ai_saved_email') || '';

  if (shouldRemember && savedEmail) {
    setValues((prev) => ({ ...prev, email: savedEmail }));
    setRemember(true);
  }
}, [mode]); 
  const [language, setLanguage] = useState(i18n.language || 'en');
  const [identityCardFile, setIdentityCardFile] = useState(null);
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleMode, setGoogleMode] = useState('disabled');
  const [googleConfigFailed, setGoogleConfigFailed] = useState(false);
  const [googleScriptReady, setGoogleScriptReady] = useState(Boolean(window.google?.accounts?.id));
  const [googleScriptFailed, setGoogleScriptFailed] = useState(false);
  const googleButtonRef = useRef(null);
  const [departments, setDepartments] = useState([]);
  const [locationOptions, setLocationOptions] = useState([]);

  const isRegister = mode === 'register';
  const isLogin = mode === 'login';
  const isOfficial = role === 'official';
  const isAdmin = role === 'admin';
  const selectedState = locationOptions.find((item) => item.name === values.state);
  const selectedDistrict = selectedState?.districts.find((item) => item.name === values.district);
  const title = isLogin
    ? t('login')
    : isAdmin
      ? t('register') + ' - ' + t('admin')
      : isOfficial
        ? t('register') + ' - ' + t('official')
        : t('register') + ' - ' + t('citizen');

  const endpoint = useMemo(() => {
    if (isLogin) return `/auth/login/${role}`;
    if (isAdmin) return '/auth/register/admin';
    return isOfficial ? '/auth/register/official' : '/auth/register/user';
  }, [isLogin, isOfficial, isAdmin, role]);

  const handleInput = (key) => (event) => {
    setValues((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const changeLang = (lng) => {
    try { i18n.changeLanguage(lng); localStorage.setItem('smart-civic-lang', lng); setLanguage(lng);} catch(e) {}
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    // Validate contact details before sending a registration or login request.
    const errors = [];
    const email = values.email.trim();
    const phoneDigits = values.phone.replace(/\D/g, '');
    const validPhone = /^(?:\+?91)?[6-9]\d{9}$/.test(values.phone.trim().replace(/[\s()-]/g, ''));
    if (!email) errors.push('Email is required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push('Enter a valid email address');
    if (!values.password) errors.push('Password is required');
    if (!isLogin && !values.fullName.trim()) errors.push('Full name is required');
    if (isRegister && !validPhone) errors.push('Enter a valid Indian mobile number (10 digits, optionally with +91)');
    if (isRegister && values.password !== values.confirmPassword) errors.push('Passwords do not match');
    if (isRegister && values.password.length < 8) errors.push('Password must be at least 8 characters');
    if (isRegister && (!selectedState || !selectedDistrict || !selectedDistrict.taluks.includes(values.taluk))) {
      errors.push('Choose a valid state, district, and taluk');
    }
 
    // For official registration require additional fields
    if (isOfficial && isRegister) {
      if (!values.setupKey.trim()) errors.push('Official setup key is required');
      if (!values.employeeId) errors.push('Employee ID is required for officials');
      if (!values.designation) errors.push('Designation is required for officials');
      if (!values.departmentId) errors.push('Department is required for officials');
      if (!identityCardFile) errors.push('A photo of the official identity card is required');
    }
    if (isAdmin && isRegister) {
      if (!values.adminId) errors.push('Admin ID is required for admin registration');
      if (!values.department) errors.push('Department is required for admin registration');
    }

    if (errors.length) {
      setMessage({ severity: 'error', text: errors.join('. ') });
      setLoading(false);
      return;
    }

    try {
      const payload = {
        email,
        password: values.password,
        fullName: values.fullName,
        phone: isRegister ? phoneDigits.slice(-10) : values.phone,
        state: values.state,
        district: values.district,
        taluk: values.taluk,
        village: values.village,
        address: values.address,
        employeeId: values.employeeId,
        departmentId: values.departmentId,
        designation: values.designation,
        officeAddress: values.officeAddress,
        adminId: values.adminId,
        department: values.department,
        setupKey: values.setupKey,
        governmentApprovalCode: values.setupKey,
      };

      if (isOfficial && identityCardFile) {
        const formData = new FormData();
        formData.append('identityCard', identityCardFile);
        // Do not set Content-Type; axios will set multipart boundary automatically
        const uploadResult = await api.post('/auth/upload-identity', formData);
        // Expect server payload { message, data: { identityCardUrl } }
        payload.identityCardUrl = uploadResult?.data?.data?.identityCardUrl || '';
      }

      const response = await api.post(endpoint, payload);
      if (isLogin) {
        const signedInUser = response?.data?.data?.user;
        if (signedInUser?.role !== role) throw new Error(`This account is registered as ${signedInUser?.role || 'a different role'}. Please use the matching sign-in page.`);
        login(signedInUser, response?.data?.data?.accessToken);
        if (remember) {
          localStorage.setItem('ai_remember_email', 'true');
          localStorage.setItem('ai_saved_email', email);
       } 
        else {
          localStorage.removeItem('ai_remember_email');
          localStorage.removeItem('ai_saved_email');
       }
        navigate('/dashboard');
      } else {
        if (isAdmin) {
        const loginResponse = await api.post('/auth/login/admin', {
            email,
            password: values.password,
          });
          login(loginResponse.data.data.user, loginResponse.data.data.accessToken);
          navigate('/dashboard');
          return;
        }
        setMessage({ severity: 'success', text: response?.data?.message || 'Registration successful' });
      }
    } catch (error) {
      // Better error reporting: show server message when available
      const serverMsg = error?.response?.data?.data?.error || error?.response?.data?.message || error.message || 'Request failed';
      const displayMsg = isLogin && error?.response?.status === 401 && serverMsg === 'Email or password invalid'
        ? 'Email or password invalid for this account type. To use Google, choose the Sign in with Google button below. Google sign-in only works for an existing CivicAlert account linked to that Google email.'
        : error?.code === 'ERR_NETWORK' || error?.message === 'Network Error'
        ? 'Network error. Ensure the civic service is available and reachable.'
        : serverMsg;
      setMessage({ severity: 'error', text: displayMsg });
      console.error('Registration error', error?.response || error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const existingScript = document.getElementById('google-identity-services');
    if (window.google?.accounts?.id) {
      setGoogleScriptReady(true);
      return undefined;
    }

    const script = existingScript || document.createElement('script');
    const onLoad = () => {
      const ready = Boolean(window.google?.accounts?.id);
      setGoogleScriptReady(ready);
      setGoogleScriptFailed(!ready);
    };
    const onError = () => setGoogleScriptFailed(true);
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    if (!existingScript) {
      script.id = 'google-identity-services';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else {
      // A cached script can finish before this page attaches its load handler.
      window.setTimeout(onLoad, 500);
    }
    return () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
  }, []);

  useEffect(() => {
    api.get('/auth/google/config')
      .then((response) => {
        const config = response.data.data || {};
        setGoogleClientId(config.clientId || '');
        setGoogleMode(config.mode || 'disabled');
        setGoogleConfigFailed(false);
      })
      .catch(() => {
        setGoogleConfigFailed(true);
        setGoogleMode('disabled');
      });
  }, []);

  useEffect(() => {
    if (!isRegister) return;
    api.get('/auth/locations')
      .then((response) => setLocationOptions(response.data?.data?.locations || []))
      .catch(() => setMessage({ severity: 'error', text: 'Could not load the official location list. Check the server connection and reload this page.' }));
  }, [isRegister]);

  useEffect(() => {
    if (!isOfficial || !isRegister) return;
    api.get('/auth/departments')
      .then((response) => setDepartments(response.data?.data?.departments || []))
      .catch(() => setDepartments([]));
  }, [isOfficial, isRegister]);

  useEffect(() => {
    const googleId = window.google?.accounts?.id;
    const button = googleButtonRef.current;
    if (!isLogin || !googleClientId || googleMode === 'disabled' || !googleScriptReady || !googleId || !button) return;

    const roleToUse = role === 'citizen' ? 'user' : (role || 'user');
    googleId.initialize({
      client_id: googleClientId,
      callback: async (tokenResponse) => {
        if (!tokenResponse?.credential) {
          setMessage({ severity: 'error', text: 'Google did not return a sign-in credential. Please try again.' });
          return;
        }
        setLoading(true);
        setMessage(null);
        try {
          const response = await api.post('/auth/google', { credential: tokenResponse.credential, role: roleToUse });
          if (response.data.data.user?.role !== roleToUse) throw new Error(`This Google account is registered as ${response.data.data.user?.role || 'a different role'}. Use a separate account for ${roleToUse} access.`);
          login(response.data.data.user, response.data.data.accessToken);
          // Remember the Google email on this device
          const googlePayload = JSON.parse(
            atob(
              tokenResponse.credential.split('.')[1]
              .replace(/-/g, '+')
              .replace(/_/g, '/')
              .padEnd(
                Math.ceil(tokenResponse.credential.split('.')[1].length / 4) * 4,
               '='
              )
             )
          );

          localStorage.setItem('ai_saved_email', googlePayload.email || '');
          localStorage.setItem('ai_remember_email', 'true');
          
          
          navigate('/dashboard');
        } catch (error) {
          const serverMsg = error?.response?.data?.message || error.message || 'Google sign-in failed.';
          const displayMsg = error?.code === 'ERR_NETWORK' || error?.message === 'Network Error'
            ? 'Network error. Ensure the backend server is running and reachable on http://127.0.0.1:5000.'
            : serverMsg;
          setMessage({ severity: 'error', text: displayMsg });
        } finally { setLoading(false); }
      },
    });
    button.replaceChildren();
    googleId.renderButton(button, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: 320 });
    return () => button.replaceChildren();
  }, [googleClientId, googleMode, googleScriptReady, isLogin, role, login, navigate]);

  const continueWithGoogle = () => {
    if (!isLogin) {
      setMessage({ severity: 'info', text: 'Google sign-in is available from the login page only.' });
    } else if (googleConfigFailed) {
      setMessage({ severity: 'error', text: 'Could not reach the civic backend to load Google sign-in settings. Check that the backend and /api proxy are running, then reload.' });
    } else if (!googleClientId || googleMode === 'disabled') {
      setMessage({ severity: 'info', text: 'Google sign-in needs a Google OAuth Web client ID. Set GOOGLE_CLIENT_ID in backend/.env, then restart the backend.' });
    } else if (!googleScriptReady) {
      setMessage({ severity: 'info', text: googleScriptFailed ? 'Google sign-in could not load from Google. Check your network connection or browser content blockers, then reload the page.' : 'Google sign-in is still loading. Try again in a moment.' });
    }
  };

  return (
    <Container maxWidth="md" sx={{ mt: 6, mb: 8 }}>
      <Paper sx={{ p: 4, borderRadius: 4, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)' }}>
        <Grid container spacing={4}>
          <Grid item xs={12} md={6} sx={{ position: 'relative' }}>
            <Box sx={{ position: 'absolute', top: -28, right: -28, width: 110, height: 110, borderRadius: '50%', background: 'rgba(255,255,255,0.08)' }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2, mb: 2 }}>
              <Typography variant="h3" sx={{ fontWeight: 800, mb: 0 }}>
                {title}
              </Typography>
              <Box sx={{ position: 'absolute', top: 8, left: 8 }}>
                <img src="/logo.svg" alt="logo" width={56} height={56} onError={(e)=>{e.currentTarget.onerror=null; e.currentTarget.src='/fallback-logo.svg'}} />
              </Box>
              <TextField
                select
                size="small"
                value={language}
                onChange={(event) => { const lng = event.target.value; changeLang(lng); }}
                sx={{ minWidth: 140, bgcolor: 'rgba(255,255,255,0.08)', borderRadius: 2 }}
              >
                <MenuItem value="en">English</MenuItem>
                <MenuItem value="kn">ಕನ್ನಡ</MenuItem>
              </TextField>
            </Box>
            <Box component="form" noValidate onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2 }}>
              {!isLogin && (
                <TextField
                  required
                  label={t('fullName')}
                  variant="filled"
                  value={values.fullName}
                  onChange={handleInput('fullName')}
                />
              )}
              <TextField
                required
                label={t('email')}
                type="email"
                variant="filled"
                value={values.email}
                onChange={handleInput('email')}
              />
              <TextField
                required
                label={t('password')}
                variant="filled"
                type={showPassword ? 'text' : 'password'}
                value={values.password}
                onChange={handleInput('password')}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowPassword((value) => !value)} edge="end">
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              {isRegister && (
                <TextField
                  required
                  label={t('confirmPassword')}
                  variant="filled"
                  type={showPassword ? 'text' : 'password'}
                  value={values.confirmPassword}
                  onChange={handleInput('confirmPassword')}
                />
              )}
              {isAdmin && isRegister && (
                <>
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        required
                        label="Admin ID"
                        variant="filled"
                        value={values.adminId}
                        onChange={handleInput('adminId')}
                        fullWidth
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField
                        required
                        label="Department"
                        variant="filled"
                        value={values.department}
                        onChange={handleInput('department')}
                        fullWidth
                      />
                    </Grid>
                  </Grid>
                  <TextField
                    label="Government Approval Code"
                    variant="filled"
                    value={values.setupKey}
                    onChange={handleInput('setupKey')}
                    fullWidth
                    helperText="Optional only when registering the first admin. For additional admins, use the code configured by the system owner."
                  />
                </>
              )}
              {!isLogin && (
                <>
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={6}>
                      <TextField required select label="State" variant="filled" value={values.state} onChange={(event) => setValues((previous) => ({ ...previous, state: event.target.value, district: '', taluk: '' }))} fullWidth>
                        <MenuItem value="" disabled>Select state / UT</MenuItem>
                        {locationOptions.map((item) => <MenuItem key={item.name} value={item.name}>{item.name}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField required select label={t('district')} variant="filled" value={values.district} disabled={!selectedState} onChange={(event) => setValues((previous) => ({ ...previous, district: event.target.value, taluk: '' }))} fullWidth>
                        <MenuItem value="" disabled>Select district</MenuItem>
                        {(selectedState?.districts || []).map((item) => <MenuItem key={item.name} value={item.name}>{item.name}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField required select label={t('taluk')} variant="filled" value={values.taluk} disabled={!selectedDistrict} onChange={handleInput('taluk')} fullWidth>
                        <MenuItem value="" disabled>Select taluk</MenuItem>
                        {(selectedDistrict?.taluks || []).map((item) => <MenuItem key={item} value={item}>{item}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField required label={t('village')} variant="filled" value={values.village} onChange={handleInput('village')} fullWidth />
                    </Grid>
                    <Grid item xs={12}>
                      <TextField required label={t('phone')} type="tel" variant="filled" value={values.phone} onChange={handleInput('phone')} inputProps={{ inputMode: 'tel', autoComplete: 'tel', maxLength: 16 }} helperText="Indian mobile number, 10 digits; +91 is optional" fullWidth />
                    </Grid>
                  </Grid>
                  <TextField required label={t('address')} variant="filled" value={values.address} onChange={handleInput('address')} />
                </>
              )}
              {isOfficial && isRegister && (
                <>
                  <TextField required label="Official Setup Key" variant="filled" value={values.setupKey} onChange={handleInput('setupKey')} fullWidth helperText="Enter the setup key provided by your system administrator." />
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={6}>
                      <TextField required label="Employee ID" variant="filled" value={values.employeeId || ''} onChange={handleInput('employeeId')} fullWidth />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField required select label="Civic category handled" variant="filled" value={values.departmentCategory || ''} onChange={(event) => {
                        const category = event.target.value;
                        const departmentName = CATEGORY_DEPARTMENT_NAMES[category];
                        const department = departments.find((item) => item.name === departmentName);
                        setValues((previous) => ({ ...previous, departmentCategory: category, departmentId: department ? String(department.id) : '' }));
                      }} fullWidth helperText="Uses the same categories citizens choose; cases route to the matching service department.">
                        <MenuItem value="" disabled>Select civic category</MenuItem>
                        {CIVIC_CATEGORIES.map((category) => <MenuItem key={category} value={category}>{category}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField label="Designation" variant="filled" value={values.designation || ''} onChange={handleInput('designation')} fullWidth />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField label="Office Address" variant="filled" value={values.officeAddress || ''} onChange={handleInput('officeAddress')} fullWidth />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <Button variant="outlined" component="label" fullWidth sx={{ height: '100%' }}>
                        {t('uploadIdentity')}
                        <input type="file" hidden accept=".jpg,.jpeg,.jpe,.jfif,.png,.apng,.webp,.bmp,.dib,.tif,.tiff,.gif,.avif,.jp2,.j2k,.ico,.tga" onChange={(event) => {
                          const file = event.target.files?.[0] || null;
                          if (file && (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024)) {
                            setIdentityCardFile(null);
                            setMessage({ severity: 'error', text: 'Upload a supported image ID photo up to 5 MB.' });
                            event.target.value = '';
                            return;
                          }
                          setIdentityCardFile(file);
                        }} />
                      </Button>
                      <Typography variant="caption" sx={{ mt: 1, color: 'grey.400', display: 'block' }}>
                        Upload a clear supported image (maximum 5 MB).
                      </Typography>
                      {identityCardFile && <Typography sx={{ mt: 1, color: 'grey.300' }}>{identityCardFile.name}</Typography>}
                    </Grid>
                  </Grid>
                </>
              )}
              <FormControlLabel
                control={<Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)} />}
                label={t('rememberMe')}
              />
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                <Button type="submit" variant="contained" size="large" disabled={loading}>
                  {isLogin ? t('signIn') : t('register')}
                </Button>
                <Button component={Link} to="/auth/forgot-password" variant="text" sx={{ color: 'secondary.main' }}>
                  {t('forgotPassword')}
                </Button>
              </Box>
              <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {isLogin && googleClientId && googleMode !== 'disabled' && googleScriptReady
                  ? <Box ref={googleButtonRef} sx={{ minHeight: 40, display: 'flex', alignItems: 'center' }} />
                  : <Button variant="outlined" size="small" fullWidth disabled={loading} onClick={continueWithGoogle} sx={{ textTransform: 'none' }}>{t('google')}</Button>}
              </Box>
              {message && <Alert severity={message.severity}>{message.text}</Alert>}
            </Box>
            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
              {isLogin ? (
                <Typography sx={{ color: 'grey.300' }}>
                  {t('needAccount')} <Link to={`/auth/register/${role}`} style={{ color: '#00d4ff' }}>{role === 'official' ? t('registerAsOfficial') : role === 'admin' ? t('registerAsAdmin') : t('registerAsCitizen')}</Link>
                </Typography>
              ) : (
                <Typography sx={{ color: 'grey.300' }}>
                  {t('alreadyHaveAccount')} <Link to={`/auth/login/${role}`} style={{ color: '#00d4ff' }}>{role === 'admin' ? t('signInAsAdmin') : role === 'official' ? t('signInAsOfficial') : t('signIn')}</Link>
                </Typography>
              )}
            </Box>
          </Grid>
          <Grid item xs={12} md={6} sx={{ display: { xs: 'none', md: 'block' } }}>
            <Box sx={{ borderRadius: 4, overflow: 'hidden', position: 'relative', minHeight: 520, backgroundImage: 'linear-gradient(135deg, rgba(13, 23, 60, 0.88), rgba(8, 63, 90, 0.85)), url(https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1300&q=80)', backgroundSize: 'cover', backgroundPosition: 'center' }}>
              <Box sx={{ position: 'absolute', inset: 0, opacity: 0.55, background: 'linear-gradient(180deg, rgba(9, 30, 66, 0.92), rgba(8, 39, 64, 0.82))' }} />
                <Box sx={{ position: 'relative', p: 5, color: 'common.white', height: '100%' }}>
                <Typography variant="h4" sx={{ fontWeight: 800, mb: 3 }}>
                  CivicAlert
                </Typography>
                <Box sx={{ display: 'grid', gap: 2 }}>
                  <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <FaEnvelope /> <Typography>{t('citizenComplaintIntake')}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <FaLock /> <Typography>{t('roleAwareAccess')}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                    <FaMapMarkerAlt /> <Typography>{t('incidentLocationTracking')}</Typography>
                  </Box>
                </Box>
              </Box>
            </Box>
          </Grid>
        </Grid>
      </Paper>
    </Container>
  );
}
