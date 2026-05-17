import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");

export function countTokens(text: string): number {
  return enc.encode(text).length;
}

export function truncateToBudget(text: string, budget: number): string {
  const tokens = enc.encode(text);
  if (tokens.length <= budget) return text;
  return enc.decode(tokens.slice(0, budget));
}
