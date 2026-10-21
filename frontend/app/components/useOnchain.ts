"use client";

import { useReadContract } from "wagmi";
import { PULSE_ABI } from "../../lib/abi";
import { PULSE_CONTRACT_ADDRESS } from "../../lib/wagmiConfig";

export const CHAIN_STATUS = ["active", "paused", "cancelled", "expired"] as const;
export type ChainStatus = (typeof CHAIN_STATUS)[number];

/** A permission exactly as the contract reports it (read live, never cached in the database). */
export interface OnchainPermission {
  owner: string;
  asset: string;
  recipient: string;
  maxPerExecution: bigint;
  maxPerWindow: bigint;
  windowSeconds: bigint;
  expiresAt: bigint;
  windowStart: bigint;
  spentInWindow: bigint;
  status: ChainStatus;
  weekday: number;
  conditionOp: number;
  conditionThreshold: bigint;
  lastExecutionDay: bigint;
  priceFeed: string;
  priceOp: number;
  priceDecimals: number;
  priceThreshold: bigint;
  maxPriceAge: bigint;
}

/**
 * Reads getPermission(id) from the contract. The ABI declares flat outputs (see lib/abi.ts), so
 * the result is a positional array whose order matches the Solidity struct.
 */
export function useOnchainPermission(onchainId?: string) {
  const enabled = Boolean(onchainId) && Boolean(PULSE_CONTRACT_ADDRESS);
  const q = useReadContract({
    address: PULSE_CONTRACT_ADDRESS,
    abi: PULSE_ABI,
    functionName: "getPermission",
    args: enabled ? [BigInt(onchainId as string)] : undefined,
    query: { enabled, staleTime: 5_000 },
  });
  const r = q.data as unknown as readonly any[] | undefined;
  const permission: OnchainPermission | undefined = r
    ? {
        owner: r[0], asset: r[1], recipient: r[2],
        maxPerExecution: r[3], maxPerWindow: r[4], windowSeconds: r[5], expiresAt: r[6],
        windowStart: r[7], spentInWindow: r[8],
        status: CHAIN_STATUS[Number(r[9])],
        weekday: Number(r[10]), conditionOp: Number(r[11]), conditionThreshold: r[12],
        lastExecutionDay: r[13],
        priceFeed: r[14], priceOp: Number(r[15]), priceDecimals: Number(r[16]),
        priceThreshold: r[17], maxPriceAge: r[18],
      }
    : undefined;
  return { permission, isLoading: q.isLoading, isError: q.isError, refetch: q.refetch };
}
