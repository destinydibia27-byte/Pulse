import { getAddress, isAddress } from "viem";

/**
 * Arbitrum Sepolia native test USDC (Circle).
 * Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * Explorer: https://sepolia.arbiscan.io/address/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
 * Checked against Circle's docs on 2026-09-28. Do NOT confuse with Arbitrum One's
 * USDC (0xaf88...5831), which is a mainnet token. Re-check Circle's page before
 * a demo: testnet addresses can change.
 */
export const ARBITRUM_SEPOLIA_USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

/**
 * Well-known Anvil dev account #3. Its private key is PUBLIC, so anyone can move
 * funds sent here. Acceptable only as an offline/testnet demo default for the
 * "savings" recipient; set DEMO_SAVINGS_ADDRESS to your own wallet for real demos.
 */
export const DEMO_SAVINGS_FALLBACK = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

/** Fails loudly at startup on a malformed/bad-checksum address instead of deep inside viem. */
export function requireAddress(label: string, value: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new Error(
      `${label} is not a valid EVM address (got "${value}", ${value.length - 2} hex chars, expected 40 with a valid checksum).`
    );
  }
  return getAddress(value);
}

export function resolveUsdcAddress(): `0x${string}` {
  return requireAddress(
    "USDC address (NEXT_PUBLIC_USDC_ADDRESS)",
    process.env.NEXT_PUBLIC_USDC_ADDRESS || ARBITRUM_SEPOLIA_USDC
  );
}
