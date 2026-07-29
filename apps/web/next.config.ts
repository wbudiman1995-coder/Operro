import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Temporary mitigation until Next.js ships a patched Sharp dependency.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
