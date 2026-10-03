const path = require("path");
// One .env at the repo root for the whole project (documented monorepo pattern).
// Real environment variables still win over the file.
require("@next/env").loadEnvConfig(path.resolve(__dirname, ".."));

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // wagmi's connector barrel transitively imports the Coinbase/Base SDK,
    // which has optional x402 payment deps we don't use (Pulse only uses the
    // injected browser-wallet connector). Stub them so the build resolves.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/evm/exact/client": false,
      "@x402/evm/upto/client": false,
      "@x402/svm/exact/client": false,
    };
    return config;
  },
};
module.exports = nextConfig;
