import { Intent } from "./schema";

/**
 * A user's pre-approved recipient addresses, keyed by the label they use
 * in natural language ("savings" -> 0x...). The parser can only ever
 * reference a label (recipientId); it never sees or invents a raw address.
 * In a real build this comes from a DB row the user set up out-of-band
 * (e.g. when they first connect a "savings wallet").
 */
export interface ApprovedRecipients {
  [userId: string]: { [label: string]: `0x${string}` };
}

export interface ResolvedPolicy {
  asset: `0x${string}`; // USDC token address on the target chain
  recipient: `0x${string}`;
  amount: bigint; // what each run actually sends (<= maxPerExecution)
  maxPerExecution: bigint; // in token base units
  maxPerWindow: bigint;
  windowSeconds: number; // 7 * 24 * 60 * 60 for weekly
  expiresAt: number; // unix seconds
  weekday: number; // on-chain weekday, 0 = Sunday .. 6 = Saturday, in UTC (see ONCHAIN_WEEKDAY)
  conditionOp: number; // on-chain Op enum index (see ONCHAIN_OP)
  conditionThreshold: bigint; // balance threshold in token base units
}

export class PolicyRejection extends Error {}

/**
 * On-chain weekday encoding: 0 = Sunday .. 6 = Saturday, evaluated in UTC (the contract has
 * no reliable source of the user's timezone). Typed as an exhaustive Record over the schema's
 * own enum, so adding a day to the schema is a compile error until it is mapped here.
 */
export const ONCHAIN_WEEKDAY: Record<Intent["trigger"]["day"], number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * On-chain `Op` enum, in the contract's declaration order: GT, GTE, LT, LTE, EQ. These values
 * are persisted on-chain, so the order can never change. Exhaustive over the schema's operators.
 */
export const ONCHAIN_OP: Record<Intent["condition"]["operator"], number> = {
  ">": 0,
  ">=": 1,
  "<": 2,
  "<=": 3,
  "==": 4,
};

const USDC_DECIMALS = 6;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/**
 * Turns a validated Intent into contract-ready parameters, enforcing that
 * the recipient is one the user actually pre-approved. This is the hard
 * boundary: nothing after this point can be influenced by free text again.
 */
export function resolvePolicy(
  userId: string,
  intent: Intent,
  usdcAddress: `0x${string}`,
  approved: ApprovedRecipients
): ResolvedPolicy {
  const userRecipients = approved[userId];
  if (!userRecipients) {
    throw new PolicyRejection(`No approved recipients on file for user ${userId}`);
  }
  const recipient = userRecipients[intent.recipientId];
  if (!recipient) {
    throw new PolicyRejection(
      `"${intent.recipientId}" is not a pre-approved recipient. Add it in wallet settings first.`
    );
  }

  const maxPerExecution = toBaseUnits(intent.maxPerExecution);
  const maxPerWindow = toBaseUnits(intent.maxPerWindow);
  const amount = toBaseUnits(intent.action.amount);

  if (amount <= 0n) {
    throw new PolicyRejection("The amount to send must be greater than zero.");
  }
  if (amount > maxPerExecution) {
    // Without this, a rule could be approved that the contract rejects on every run.
    throw new PolicyRejection("The amount sent each time cannot exceed the per-execution cap.");
  }

  if (maxPerExecution > maxPerWindow) {
    throw new PolicyRejection("Per-execution cap cannot exceed the weekly cap.");
  }

  const expiresAt = Math.floor(new Date(intent.expiresAt).getTime() / 1000);
  if (expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new PolicyRejection("Expiration must be in the future.");
  }

  return {
    asset: usdcAddress,
    recipient,
    amount,
    maxPerExecution,
    maxPerWindow,
    windowSeconds: WEEK_SECONDS,
    expiresAt,
    weekday: ONCHAIN_WEEKDAY[intent.trigger.day],
    conditionOp: ONCHAIN_OP[intent.condition.operator],
    conditionThreshold: toBaseUnits(intent.condition.balance),
  };
}

/**
 * Decimal string -> USDC base units. Rejects (rather than silently truncating)
 * anything with more precision than the token supports, so a cap the user typed
 * is never quietly changed into a different number.
 */
export function toBaseUnits(decimalString: string): bigint {
  const [whole, frac = ""] = decimalString.split(".");
  if (frac.length > USDC_DECIMALS) {
    throw new PolicyRejection(
      `"${decimalString}" has more than ${USDC_DECIMALS} decimal places, which USDC cannot represent.`
    );
  }
  const paddedFrac = frac.padEnd(USDC_DECIMALS, "0");
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(paddedFrac || "0");
}

export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 10n ** BigInt(USDC_DECIMALS);
  const frac = (baseUnits % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}

/**
 * "Check rule" — NOT a simulation of the future. It answers: is this policy
 * well-formed, and given the user's balance RIGHT NOW, would the condition pass
 * and could the balance cover one execution? It says nothing about the balance
 * at the actual trigger time (that is unknown until it fires).
 *
 * `issues` are hard problems that should block approval.
 * `warnings` are informational and must NOT block: e.g. a user may legitimately
 * set up an automation before funding the wallet.
 */
export interface RuleCheckResult {
  wellFormed: boolean;
  recipientApproved: boolean;
  currentConditionWouldPass: boolean | null; // null = balance not read
  balanceCoversExecution: boolean | null; // null = balance not read
  issues: string[];
  warnings: string[];
}

export function checkRule(
  policy: ResolvedPolicy,
  currentBalanceBaseUnits: bigint | null,
  conditionOperator: Intent["condition"]["operator"],
  conditionThresholdBaseUnits: bigint
): RuleCheckResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (policy.maxPerExecution <= 0n) issues.push("Per-execution cap must be greater than zero.");
  if (policy.expiresAt <= Math.floor(Date.now() / 1000)) issues.push("Policy is already expired.");

  let currentConditionWouldPass: boolean | null = null;
  let balanceCoversExecution: boolean | null = null;

  if (currentBalanceBaseUnits !== null) {
    currentConditionWouldPass = compare(
      currentBalanceBaseUnits,
      conditionOperator,
      conditionThresholdBaseUnits
    );
    balanceCoversExecution = currentBalanceBaseUnits >= policy.maxPerExecution;
    if (!balanceCoversExecution) {
      warnings.push(
        `Your current balance (${formatUsdc(currentBalanceBaseUnits)} USDC) is below the ` +
          `${formatUsdc(policy.maxPerExecution)} USDC this automation sends, so it would fail right now.`
      );
    }
  }

  return {
    wellFormed: issues.length === 0,
    recipientApproved: true, // resolvePolicy already threw if not
    currentConditionWouldPass,
    balanceCoversExecution,
    issues,
    warnings,
  };
}

export function compare(a: bigint, op: Intent["condition"]["operator"], b: bigint): boolean {
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    case "==": return a === b;
  }
}
