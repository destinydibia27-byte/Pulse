import { test } from "node:test";
import assert from "node:assert/strict";
import { combineFollowUp, COMBINED_MAX } from "../src/followUp";

const SRC = "Send $10 to savings when my balance is above $100.";

test("follow-up: a short answer is joined onto the original sentence", () => {
  assert.equal(combineFollowUp(SRC, "Friday"), "Send $10 to savings when my balance is above $100. Friday");
  assert.equal(combineFollowUp(SRC, "  every Friday  "), "Send $10 to savings when my balance is above $100. every Friday");
});

test("follow-up: trailing punctuation on the original does not double up", () => {
  assert.equal(combineFollowUp("Send $10 to savings every Friday,", "when my balance is above $100"), "Send $10 to savings every Friday. when my balance is above $100");
});

test("follow-up: with nothing pending the reply stands alone", () => {
  assert.equal(combineFollowUp(null, "Friday"), "Friday");
  assert.equal(combineFollowUp(undefined, " hello "), "hello");
  assert.equal(combineFollowUp("", "Friday"), "Friday");
});

test("follow-up: a reply that is a full new request (two numbers) is not joined", () => {
  const fresh = "Every Monday send $25 to rent if my balance is above $500";
  assert.equal(combineFollowUp(SRC, fresh), fresh);
});

test("follow-up: a long reply is treated as a new request", () => {
  const long = "x".repeat(81);
  assert.equal(combineFollowUp(SRC, long), long);
});

test("follow-up: one number in a short answer is still an answer", () => {
  assert.equal(combineFollowUp("Every Friday send $10 to savings", "if my balance is above $100"), "Every Friday send $10 to savings. if my balance is above $100");
});

test("follow-up: the joined text never grows past the cap", () => {
  const big = "a".repeat(COMBINED_MAX);
  assert.equal(combineFollowUp(big, "Friday"), "Friday");
});
