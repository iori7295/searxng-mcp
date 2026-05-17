import { logger } from "./logger.js";

export const circuitState = new Map<
  string,
  { failures: number; openUntil: number }
>();

export function isCircuitOpen(service: string): boolean {
  const state = circuitState.get(service);
  if (!state) return false;
  if (state.failures < 3) return false;
  if (Date.now() >= state.openUntil) {
    circuitState.delete(service);
    return false;
  }
  return true;
}

export function recordFailure(service: string): void {
  const state = circuitState.get(service) ?? { failures: 0, openUntil: 0 };
  state.failures++;
  if (state.failures >= 3) {
    state.openUntil = Date.now() + 5 * 60 * 1000;
    logger.warn(`Circuit breaker: ${service} opened for 5 minutes`);
  }
  circuitState.set(service, state);
}

export function recordSuccess(service: string): void {
  circuitState.delete(service);
}
