import React, { forwardRef, useEffect, useState } from 'react';
import axios from 'axios';
import { assetUrl } from '../services/api';

function useAuthenticatedAsset(url) {
  const [source, setSource] = useState('');

  useEffect(() => {
    if (!url) {
      setSource('');
      return undefined;
    }

    if (!String(url).startsWith('/uploads/')) {
      setSource(assetUrl(url));
      return undefined;
    }

    let active = true;
    let objectUrl;
    const token = localStorage.getItem('ai_access_token');
    axios.get(assetUrl(url), {
      responseType: 'blob',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(response => {
      objectUrl = URL.createObjectURL(response.data);
      if (active) setSource(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(error => {
      if (active) {
        console.error('Unable to load private evidence.', error);
        setSource('');
      }
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return source;
}

export const AuthenticatedImage = forwardRef(({ url, src, ...props }, ref) => {
  const source = useAuthenticatedAsset(url || src);
  return <img ref={ref} src={source || undefined} {...props} />;
});

export const AuthenticatedAssetLink = forwardRef(({ url, href, ...props }, ref) => {
  const source = useAuthenticatedAsset(url || href);
  return <a ref={ref} href={source || undefined} {...props} />;
});
