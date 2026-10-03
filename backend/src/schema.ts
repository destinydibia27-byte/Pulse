import { z } from "zod";

/**
 * This is the ONLY shape an intent can take. The AI parser must produce
 * exactly this schema or the request is rejected. Nothing free-form from
 * the user (or from any content the AI might have read) ever reaches the
 * policy engine or the contract call — it passes through this gate first.
 */

export const ConditionSchema = z.object({
  asset: z.literal("USDC"), // MVP: USDC only
  operator: z.enum([">", ">=", "<", "<=", "=="]),
  balance: z.string().regex(/^\d+(\.\d+)?$/, "balance must be a plain decimal string"),
});

export const TriggerSchema = z.object({
  type: z.literal("schedule"),
  frequency: z.literal("weekly"), // MVP: weekly only
  day: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
});

export const ActionSchema = z.object({
  type: z.literal("transfer"), // MVP: only allowlisted action type
  asset: z.literal("USDC"),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a plain decimal string"),
});

export const IntentSchema = z.object({
  trigger: TriggerSchema,
  condition: ConditionSchema,
  action: ActionSchema,
  // recipient must already be one of the user's pre-approved addresses —
  // the parser fills in an id, it never invents or receives a raw address
  recipientId: z.string().min(1),
  maxPerExecution: z.string().regex(/^\d+(\.\d+)?$/),
  maxPerWindow: z.string().regex(/^\d+(\.\d+)?$/),
  expiresAt: z.string().datetime(), // ISO 8601
});

export type Intent = z.infer<typeof IntentSchema>;

/**
 * Parses and validates. Throws (never silently repairs) on anything that
 * doesn't fit. This is the enforcement boundary between "AI understood
 * something" and "a rule exists."
 */
export function parseIntentStrict(raw: unknown): Intent {
  const result = IntentSchema.safeParse(raw);
  if (!result.success) {
    throw new IntentValidationError(result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}

export class IntentValidationError extends Error {
  constructor(message: string) {
    super(`Intent rejected — did not match required schema: ${message}`);
    this.name = "IntentValidationError";
  }
}
