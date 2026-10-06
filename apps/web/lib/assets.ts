'use client';

import { useEffect, useState } from 'react';
import { loadConfig } from './config';

/**
 * Uploaded images are stored as root-relative paths (/b/{tenant}/{hash}.jpg). On the deployed site that is the same
 * origin; under `next dev` they live on the CloudFront site named in config.json.
 */
export function useAssetUrl(path: string | undefined): string | undefined {
  const [base, setBase] = useState('');
  useEffect(() => {
    if (!path?.startsWith('/b/')) return;
    loadConfig()
      .then((c) => setBase(c.siteUrl && c.siteUrl !== window.location.origin ? c.siteUrl : ''))
      .catch(() => undefined);
  }, [path]);
  if (!path) return undefined;
  return path.startsWith('/b/') ? `${base}${path}` : path;
}
