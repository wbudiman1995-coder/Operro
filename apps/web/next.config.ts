import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Temporary security mitigation until Next.js ships sharp >= 0.35.0.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
