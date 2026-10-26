import axios from 'axios';

const resolveBaseUrl = () => {
  const configured = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (configured) return configured.endsWith('/api') ? configured : `${configured.replace(/\/+$/, '')}/api`;
  // Same-origin requests work through Vite's development proxy and through
  // the production reverse proxy, avoiding browser CORS/network failures.
  return '/api';
};

const api = axios.create({
  baseURL: resolveBaseUrl(),
  withCredentials: true,
});

// Uploaded evidence is served by Flask, not the Vite frontend.  Keep absolute
// URLs untouched while resolving backend-relative upload paths correctly.
export const assetUrl = (url) => {
  if (!url || /^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
  return `${api.defaults.baseURL.replace(/\/api\/?$/, '')}/${url.replace(/^\/+/, '')}`;
};

export const dialNumber = (number) => {
  const dialable = String(number || '').replace(/[^0-9+]/g, '');
  if (dialable) window.location.href = `tel:${dialable}`;
};

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('ai_access_token');
  const headers = config.headers || {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (config.data instanceof FormData) {
    delete headers['Content-Type'];
  } else if (!headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  config.headers = headers;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    return Promise.reject(error);
  }
);
export const validateImage = async (imageFile, selectedCategory) => {
  const formData = new FormData();
  formData.append("image", imageFile);
  formData.append("selected_category", selectedCategory);

  const response = await api.post("/validate-image", formData);
  return response.data;
};

export default api;
