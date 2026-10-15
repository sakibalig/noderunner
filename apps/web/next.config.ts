import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@noderunner/core"],
  poweredByHeader: false,
};

export default config;
