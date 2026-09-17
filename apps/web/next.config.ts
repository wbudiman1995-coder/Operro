import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    serverActions: {
      allowedOrigins: (process.env.OPERRO_SERVER_ACTION_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    },
  },
  // Temporary mitigation until Next.js ships a patched Sharp dependency.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
