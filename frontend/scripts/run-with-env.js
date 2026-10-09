#!/usr/bin/env node
/**
 * Runs `next <command>` with the repo-root .env already in the process environment.
 *
 * Why this exists: loading the root .env from next.config.js is not enough. Verified by
 * reproduction: with the right values in the root .env and nothing exported in the shell,
 * `next start` served API routes that could NOT see them (no RPC, and the savings recipient
 * silently fell back to the public demo address). Putting the variables in the environment of
 * the Next process before it starts avoids that entirely.
 *
 * Real environment variables still win over the file. Needs Node >= 20.12 (loadEnvFile).
 */
const path = require("path");
const { spawn } = require("child_process");

const envFile = path.resolve(__dirname, "..", "..", ".env");
try {
  process.loadEnvFile(envFile);
} catch (err) {
  if (err && err.code !== "ENOENT") throw err; // a missing file is fine; a broken one is not
}

// Names only, never values: make a missing setting obvious at startup instead of at send time.
const watched = ["ARBITRUM_SEPOLIA_RPC_URL", "PULSE_CONTRACT_ADDRESS", "NEXT_PUBLIC_PULSE_CONTRACT_ADDRESS", "DEMO_SAVINGS_ADDRESS"];
const missing = watched.filter((k) => !process.env[k]);
console.log(`[pulse] env file: ${envFile}`);
console.log(missing.length ? `[pulse] NOT SET: ${missing.join(", ")}` : "[pulse] all key settings present");
if (!process.env.DEMO_SAVINGS_ADDRESS) {
  console.log("[pulse] WARNING: DEMO_SAVINGS_ADDRESS is not set, so \"savings\" is a PUBLIC demo address anyone can spend from.");
}

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
