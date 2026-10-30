import { test } from "node:test";
import assert from "node:assert/strict";
import { numbersWithPositions, countNumbers } from "../src/numbers";

const vals = (t: string) => numbersWithPositions(t).map((n) => n.value);

test("numbers: digits, commas and decimals", () => {
  assert.deepEqual(vals("send $10 when above $1,000.50"), [10, 1000.5]);
});

test("numbers: k, m and thousand/million suffixes", () => {
  assert.deepEqual(vals("move $1k if I have $2.5k"), [1000, 2500]);
  assert.deepEqual(vals("keep 3 million and 5 thousand"), [3_000_000, 5_000]);
  assert.deepEqual(vals("every 5 months"), [5]); // 'm' inside a word is not a million
});

test("numbers: words, including hyphens, 'a hundred' and 'and'", () => {
  assert.deepEqual(vals("send ten"), [10]);
  assert.deepEqual(vals("send twenty-five"), [25]);
  assert.deepEqual(vals("above a hundred"), [100]);
  assert.deepEqual(vals("two hundred and fifty dollars"), [250]);
  assert.deepEqual(vals("one thousand five hundred"), [1500]);
  assert.deepEqual(vals("a thousand"), [1000]);
});

test("numbers: separate numbers are not merged", () => {
  assert.deepEqual(vals("send ten, then twenty"), [10, 20]);
  assert.deepEqual(vals("ten and fifty"), [10, 50]);
  assert.deepEqual(vals("send ten to five accounts"), [10, 5]);
});

test("numbers: mixed digits and words keep their order", () => {
  assert.deepEqual(vals("send ten when I have 500"), [10, 500]);
  assert.equal(countNumbers("send ten when I have a hundred"), 2);
  assert.equal(countNumbers("every Friday"), 0);
});

test("numbers: ordinary words are not numbers", () => {
  assert.deepEqual(vals("an apple a day, tentative, someone, tone"), []);
});
