import { http, type Account, type Address, type Chain, type Hex, type PublicClient, type TransactionReceipt, type Transport, type WalletClient } from "viem";
import { arbitrumSepolia } from "viem/chains";

/**
 * ZeroDev smart-account support (browser side). OFF unless NEXT_PUBLIC_ZERODEV_PROJECT_ID is set:
 * with no project id, nothing here runs and the app behaves exactly as before (plain wallet).
 *
 * The smart account is a ZeroDev Kernel account owned by the user's normal wallet. It has its own
 * address, and THAT address is the owner of the Volo permission and the holder of the USDC.
 * Transactions go out as sponsored UserOperations, so the user needs no ETH for them.
 * The Volo contract and the worker are unchanged.
 */

export const ZERODEV_PROJECT_ID = (process.env.NEXT_PUBLIC_ZERODEV_PROJECT_ID ?? "").trim();
export const zerodevEnabled = ZERODEV_PROJECT_ID.length > 0;

/** One URL serves both the bundler and the paymaster (ZeroDev v3 RPC). Arbitrum Sepolia = 421614. */
export const zerodevRpcUrl = `https://rpc.zerodev.app/api/v3/${ZERODEV_PROJECT_ID}/chain/${arbitrumSepolia.id}`;

export interface SmartCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface SmartAccountHandle {
  /** The smart account's own address: the owner of any permission created through it. */
  address: Address;
  /** Sends the calls as ONE sponsored UserOperation and waits until it is mined. */
  sendCalls(calls: SmartCall[]): Promise<{ userOpHash: Hex; receipt: TransactionReceipt }>;
  /** EIP-191 message signature that the account contract validates (ERC-1271). */
  signMessage(message: string): Promise<Hex>;
}

/**
 * Builds the account and its client. The SDK is imported on demand so people who never use a smart
 * account do not download it.
 */
export async function buildSmartAccount(
  walletClient: WalletClient<Transport, Chain | undefined, Account>,
  publicClient: PublicClient
): Promise<SmartAccountHandle> {
  if (!zerodevEnabled) throw new Error("ZeroDev is not configured (NEXT_PUBLIC_ZERODEV_PROJECT_ID is empty).");

  const [sdk, ecdsa, constants] = await Promise.all([
    import("@zerodev/sdk"),
    import("@zerodev/ecdsa-validator"),
    import("@zerodev/sdk/constants"),
  ]);
  const entryPoint = constants.getEntryPoint("0.7");
  const kernelVersion = constants.KERNEL_V3_1;

  const validator = await ecdsa.signerToEcdsaValidator(publicClient, {
    signer: walletClient,
    entryPoint,
    kernelVersion,
  });
  const account = await sdk.createKernelAccount(publicClient, {
    plugins: { sudo: validator },
    entryPoint,
    kernelVersion,
  });

  const transport = http(zerodevRpcUrl);
  const paymaster = sdk.createZeroDevPaymasterClient({ chain: arbitrumSepolia, transport });
  const kernelClient = sdk.createKernelAccountClient({
    account,
    chain: arbitrumSepolia,
    bundlerTransport: transport,
    paymaster,
    client: publicClient,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => sdk.getUserOperationGasPrice(bundlerClient),
    },
  });

  return {
    address: account.address,
    async sendCalls(calls) {
      const userOpHash = await kernelClient.sendUserOperation({
        calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
      });
      const result = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
      if (!result.success) {
        throw new Error(`The transaction was included but failed on-chain${result.reason ? ` (${result.reason})` : ""}.`);
      }
      return { userOpHash, receipt: result.receipt };
    },
    signMessage: (message) => account.signMessage({ message }),
  };
}

/** Turns the SDK's long, technical errors into one sentence a person can act on. */
export function explainSmartError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split("\n")[0];
  const lower = raw.toLowerCase();
  if (lower.includes("http request failed") || lower.includes("fetch failed") || lower.includes("failed to fetch") || lower.includes("network")) {
    return "Could not reach the smart account service. Please try again in a moment.";
  }
  if (lower.includes("user rejected") || lower.includes("user denied")) return "You declined the request in your wallet.";
  if (lower.includes("paymaster") || lower.includes("sponsor") || lower.includes("gas policy") || lower.includes("policy")) {
    return `ZeroDev did not sponsor this transaction. Check the Gas Policy for this project in the ZeroDev dashboard (allowed contracts and limits). Details: ${first}`;
  }
  if (lower.includes("aa21") || lower.includes("didn't pay prefund") || lower.includes("prefund")) {
    return `The smart account could not pay for gas and no sponsorship applied. Details: ${first}`;
  }
  return first;
}
