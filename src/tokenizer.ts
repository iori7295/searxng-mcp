import { getEncoding } from "js-tiktoken";

let _enc: ReturnType<typeof getEncoding> | null = null;

function getEncoder(): ReturnType<typeof getEncoding> {
  if (!_enc) _enc = getEncoding("cl100k_base");
  return _enc;
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}

export function truncateToBudget(text: string, budget: number): string {
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= budget) return text;
  return enc.decode(tokens.slice(0, budget));
}
