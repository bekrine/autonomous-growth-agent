/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // NOTE: `/api/backend/*` is proxied by a Route Handler
  // (src/app/api/backend/[...path]/route.ts), not a rewrite — rewrite
  // destinations are baked in at build time, which breaks container images
  // that need to resolve API_URL at runtime.
};

export default nextConfig;
