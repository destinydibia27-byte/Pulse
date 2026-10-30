/**
 * Finds every number a person wrote, however they wrote it: "100", "1,000.50", "$1k", "2.5k",
 * "3 million", "ten", "twenty-five", "a hundred", "two hundred and fifty", "one thousand".
 * Used to check the AI's reading against the person's own words, so someone who writes "$1k" or
 * "ten dollars" is understood instead of being asked to rewrite it.
 */

export interface FoundNumber {
  value: number;
  index: number; // where it starts in the text
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const DIGITS = /\d[\d,]*(?:\.\d+)?(?:(?:k|m)\b|\s(?:thousand|million)\b)?/gi;

function digitNumbers(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  for (const m of text.matchAll(DIGITS)) {
    const raw = m[0].toLowerCase();
    const base = Number(raw.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(base)) continue;
    const mult = /k$|thousand$/.test(raw) ? 1_000 : /m$|million$/.test(raw) ? 1_000_000 : 1;
    out.push({ value: base * mult, index: m.index ?? 0 });
  }
  return out;
}

function wordNumbers(text: string): FoundNumber[] {
  // Words that already belong to a digit number ("5 thousand", "2k") are not read a second time.
  const spans = [...text.matchAll(DIGITS)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  const insideDigits = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  const tokens = [...text.matchAll(/[a-z]+/gi)]
    .map((m) => ({ w: m[0].toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((t) => !insideDigits(t.start));
  const isNum = (w: string) => w in UNITS || w in TENS || w === "hundred" || w === "thousand";
  const out: FoundNumber[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const startsPhrase = isNum(t.w) || ((t.w === "a" || t.w === "an") && i + 1 < tokens.length && (tokens[i + 1].w === "hundred" || tokens[i + 1].w === "thousand"));
    if (!startsPhrase) { i++; continue; }
    let total = 0, current = 0, used = false, prev = "", j = i;
    for (; j < tokens.length; j++) {
      const w = tokens[j].w;
      // words of one number sit next to each other, separated only by spaces or a hyphen
      if (j > i && !/^[\s-]+$/.test(text.slice(tokens[j - 1].end, tokens[j].start))) break;
      if (w in UNITS) current += UNITS[w];
      else if (w in TENS) current += TENS[w];
      else if (w === "hundred") current = (current || 1) * 100;
      else if (w === "thousand") { total += (current || 1) * 1000; current = 0; }
      else if ((w === "a" || w === "an") && j === i) { /* "a hundred" */ }
      else if (w === "and" && (prev === "hundred" || prev === "thousand") && j + 1 < tokens.length && isNum(tokens[j + 1].w)) { /* "two hundred and fifty" */ }
      else break;
      if (isNum(w)) used = true;
      prev = w;
    }
    if (used) out.push({ value: total + current, index: t.start });
    i = Math.max(j, i + 1);
  }
  return out;
}

/** Every number in the text with its position, in the order written. */
export function numbersWithPositions(text: string): FoundNumber[] {
  return [...digitNumbers(text), ...wordNumbers(text)].sort((a, b) => a.index - b.index);
}

export function countNumbers(text: string): number {
  return numbersWithPositions(text).length;
}
