/** Static export: the whole front end is files on S3 behind CloudFront. */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@dropdeck/shared'],
};
export default nextConfig;
