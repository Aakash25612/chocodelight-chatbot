import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Vercel uses its own output; standalone is for Docker only */
  ...(process.env.DOCKER_BUILD === "true" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
