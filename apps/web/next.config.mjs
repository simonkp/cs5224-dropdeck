import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

export default (phase) => {
  const development = phase === PHASE_DEVELOPMENT_SERVER;
  const demo = process.env.DROPDECK_DEMO === '1' && (development || process.env.DROPDECK_REVIEW_BUILD === '1');
  return {
    ...(development ? {} : { output: 'export' }),
    trailingSlash: true,
    images: { unoptimized: true },
    transpilePackages: ['@dropdeck/shared'],
    env: { NEXT_PUBLIC_DROPDECK_DEMO: demo ? '1' : '0' },
    ...(development ? { async rewrites() { return [
      { source: '/d/:tenant/:drop/', destination: '/d/' },
      { source: '/s/:slug/', destination: '/s/' },
      ...(process.env.DROPDECK_DEMO === '1' ? [{ source: '/__preview/', destination: '/' }] : []),
    ]; } } : {}),
  };
};
