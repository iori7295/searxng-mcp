import { readFileSync, watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import type { DomainConfig, SearxResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAINS_PATH = resolve(__dirname, "../../domains.json");

let domainConfig: DomainConfig = { boost: [], block: [], profiles: {} };

export function loadDomainConfig(): void {
  try {
    const raw = readFileSync(DOMAINS_PATH, "utf-8");
    domainConfig = JSON.parse(raw) as DomainConfig;
    domainConfig.boost ??= [];
    domainConfig.block ??= [];
    domainConfig.profiles ??= {};
  } catch (e) {
    logger.warn("Failed to load domains.json: %s", (e as Error).message);
  }
}

loadDomainConfig();
// Hot-reload via inotify (event-driven, no polling, won't keep process alive)
// Note: if domains.json does not exist at startup, the watcher setup fails and
// is not retried. The file must exist before the process starts for hot-reload
// to work. This is a known limitation: creating the file after startup requires
// a server restart.
try {
  const watcher = watch(DOMAINS_PATH, loadDomainConfig);
  watcher.unref();
} catch {
  // domains.json not found — watcher will NOT be set up later
}

export function getBlockList(profile?: string): string[] {
  const base = domainConfig.block;
  if (!profile || !domainConfig.profiles[profile]) return base;
  return [...base, ...(domainConfig.profiles[profile].block ?? [])];
}

export function getBoostList(profile?: string): string[] {
  const base = domainConfig.boost;
  if (!profile || !domainConfig.profiles[profile]) return base;
  return [...base, ...(domainConfig.profiles[profile].boost ?? [])];
}

export function urlMatchesDomain(url: string, pattern: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const pathname = new URL(url).pathname;
    // Pattern may be "domain.com" or "domain.com/path/prefix"
    if (pattern.includes("/")) {
      const [patDomain, ...patParts] = pattern.split("/");
      const patPath = `/${patParts.join("/")}`;
      return (
        (hostname === patDomain || hostname.endsWith(`.${patDomain}`)) &&
        pathname.startsWith(patPath)
      );
    }
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  } catch {
    return false;
  }
}

export function applyDomainFilters(
  results: SearxResult[],
  profile?: string,
): SearxResult[] {
  const blockList = getBlockList(profile);
  const boostList = getBoostList(profile);

  // Remove blocked domains
  const filtered = results.filter(
    (r) => !blockList.some((pat) => urlMatchesDomain(r.url, pat)),
  );

  // Single pass: boostList evaluated once per result (avoids double URL parsing)
  const boosted: SearxResult[] = [];
  const normal: SearxResult[] = [];
  for (const r of filtered) {
    if (boostList.some((pat) => urlMatchesDomain(r.url, pat))) {
      boosted.push(r);
    } else {
      normal.push(r);
    }
  }

  return [...boosted, ...normal];
}
