/**
 * web.ts — shared, non-setting concerns: fixed stream ranking, external
 * subtitle sources (always on), and the background prober that keeps
 * breaker states warm. There are no user settings in this file.
 */
import { ALL, ENABLED } from "./registry.js";
import type { SiteId } from "./registry.js";
import fs from "node:fs";
import { breaker } from "./lib.js";

/* quality order is fixed internally — not a setting. */
const RANK_ORDER = ["1080p", "720p", "4K", "480p", "360p", "HD", "CAM", "AUTO"];
const RANK_IDX = new Map(RANK_ORDER.map((r, i) => [r, i]));
export function rankStreams<T extends { name: string }>(links: T[]): T[] {
  const rank = (name: string): number => {
    const m = /^(4K|\d{3,4}p|HD|CAM|AUTO)/.exec(name);
    const r = m?.[1] ?? "AUTO";
    return RANK_IDX.has(r) ? (RANK_IDX.get(r) as number) : RANK_ORDER.length;
  };
  return [...links].sort((a, b) => rank(a.name) - rank(b.name));
}

/* external subtitle sources — always enabled, merged after each stream's own
   subs in server.ts. Add URLs here; no UI, no toggles. */
export const SUBTITLE_ADDONS: { url: string }[] = [
  { url: "https://opensubtitles-v3.strem.io/manifest.json" },
  {
    url: "https://opensubtitlesv3-pro.dexter21767.com/eyJsYW5ncyI6WyJlbmdsaXNoIl0sInNvdXJjZSI6ImFsbCIsImFpVHJhbnNsYXRlZCI6dHJ1ZSwiYXV0b0FkanVzdG1lbnQiOnRydWV9/manifest.json",
  },
  { url: "https://stremio-community-subtitles.top/manifest.json" },
];

/* stateless config-in-URL: settings travel in the install link as compact
   base64url, nothing is stored server-side. Only deviations from defaults are
   encoded, so the default install is the bare /manifest.json. */
export interface UrlConfig {
  disabled: string[];
  timeoutMs?: number;
  subsOn: boolean;
  extSubsOn: boolean;
}
const CFG_RE = /^[A-Za-z0-9_-]{2,300}$/;
export function encodeConfig(c: UrlConfig): string | null {
  const o: Record<string, unknown> = {};
  if (c.disabled.length) o.d = c.disabled;
  if (c.timeoutMs !== undefined) o.t = c.timeoutMs;
  if (!c.subsOn) o.u = 0;
  if (!c.extSubsOn) o.s = 0;
  if (!Object.keys(o).length) return null;
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
export function decodeConfig(seg: string): UrlConfig | null {
  if (!CFG_RE.test(seg)) return null;
  try {
    const o = JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    const t = typeof r.t === "number" && r.t >= 5000 && r.t <= 120000 ? r.t : undefined;
    return {
      disabled: Array.isArray(r.d) ? r.d.filter((x): x is string => typeof x === "string" && x in ALL) : [],
      timeoutMs: t,
      subsOn: r.u !== 0,
      extSubsOn: r.s !== 0,
    };
  } catch {
    return null;
  }
}
export function isConfigSeg(seg: string): boolean {
  return decodeConfig(seg) !== null;
}
/* effective settings for a request: URL config, or defaults when absent */
export function effectiveSettings(cfgSeg?: string): { providers: SiteId[]; timeoutMs: number; subsOn: boolean; extSubsOn: boolean } {
  const dflt = { providers: [...ENABLED], timeoutMs: 44000, subsOn: true, extSubsOn: true };
  if (!cfgSeg) return dflt;
  const c = decodeConfig(cfgSeg);
  if (!c) return dflt;
  const off = new Set(c.disabled);
  return {
    providers: dflt.providers.filter((id) => !off.has(id)),
    timeoutMs: c.timeoutMs ?? dflt.timeoutMs,
    subsOn: c.subsOn,
    extSubsOn: c.extSubsOn,
  };
}

/* in-memory health, updated by tests + the background prober. *//* in-memory health, updated by tests + the background prober. */
export interface HealthEntry {
  breaker: string;
  lastCheck: string | null;
  lastMs: number | null;
  lastResult: string | null;
}
const health = new Map<SiteId, HealthEntry>();
export function lastHealth(id: SiteId): { lastCheck: string | null; lastMs: number | null; lastResult: string | null } {
  const h = health.get(id);
  return { lastCheck: h?.lastCheck ?? null, lastMs: h?.lastMs ?? null, lastResult: h?.lastResult ?? null };
}
export function recordHealth(id: SiteId, ms: number, result: string): void {
  health.set(id, {
    breaker: breaker.state(id),
    lastCheck: new Date().toISOString(),
    lastMs: ms,
    lastResult: result,
  });
}

/* cheap background prober: search+load only (no streams), staggered.
   Keeps breaker states warm so /stream never pays first-contact latency. */
let proberStarted = false;
export function startProber(intervalMs = 6 * 3600_000): void {
  if (proberStarted) return;
  proberStarted = true;
  const tick = async () => {
    const { ctx } = await import("./lib.js");
    for (const id of ENABLED) {
      try {
        const prov = ALL[id];
        const t0 = Date.now();
        const s = await prov.search(
          prov.fixture as { type: "movie"; imdb: string },
          ctx(12000),
        );
        if (!s.ok || !s.value.length) {
          recordHealth(id, Date.now() - t0, s.ok ? "no-match" : s.error.code);
          continue;
        }
        const l = await prov.load(s.value[0] as never, ctx(12000));
        recordHealth(
          id,
          Date.now() - t0,
          l.ok ? `${l.value.length} servers` : l.error.code,
        );
      } catch {
        recordHealth(id, 0, "crash");
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}
