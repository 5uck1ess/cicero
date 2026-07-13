/**
 * Word Error Rate — the standard ASR accuracy metric.
 *
 * Pure and deterministic so it's unit-testable and the bench can trust it. WER =
 * (substitutions + deletions + insertions) / reference-word-count, computed via a
 * word-level edit distance with backtrace so we can report the S/D/I breakdown,
 * not just the score. Text is normalized first (lowercase, punctuation stripped,
 * whitespace collapsed) so "Hello, world." and "hello world" score as identical —
 * conversational STT shouldn't be penalized for casing or punctuation.
 */

export interface WerResult {
  wer: number; // (S+D+I)/refWords; 0 = perfect. Can exceed 1 (many insertions).
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number; // correctly matched words
  refWords: number;
}

/** Lowercase, drop punctuation (keep letters/numbers/apostrophes), split to words. */
export function normalizeForWer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Word Error Rate between a reference and a hypothesis transcript. */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = normalizeForWer(reference);
  const hyp = normalizeForWer(hypothesis);
  const n = ref.length;
  const m = hyp.length;

  if (n === 0) {
    // No reference to score against: any output is pure insertion.
    return { wer: m === 0 ? 0 : 1, substitutions: 0, deletions: 0, insertions: m, hits: 0, refWords: 0 };
  }

  // dp[i][j] = min edits to turn ref[0..i) into hyp[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i]![0] = i; // deletions
  for (let j = 0; j <= m; j++) dp[0]![j] = j; // insertions
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = 1 + Math.min(dp[i - 1]![j - 1]!, dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrace to count each operation.
  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let hits = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && dp[i]![j] === dp[i - 1]![j - 1]!) {
      hits++; i--; j--;
    } else if (i > 0 && j > 0 && dp[i]![j] === dp[i - 1]![j - 1]! + 1) {
      substitutions++; i--; j--;
    } else if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + 1) {
      deletions++; i--;
    } else {
      insertions++; j--;
    }
  }

  return { wer: (substitutions + deletions + insertions) / n, substitutions, deletions, insertions, hits, refWords: n };
}
