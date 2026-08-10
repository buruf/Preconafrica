/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@react-pdf/renderer', '@prisma/client', 'bcryptjs']
  }
}
export default nextConfig
