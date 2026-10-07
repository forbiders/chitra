/**
 * lib.ts — the 8 globals. Everything shared lives here; nothing else may.
 * Zero non-node dependencies. providers/* and server.ts import from here only.
 */

/* ── 1. result plumbing ─────────────────────────────────────────────────── */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type ErrorCode =
  | "TIMEOUT"
  | "BLOCKED"
  | "NOT_FOUND"
  | "PARSE"
  | "NEEDS_TMDB_KEY"
  | "NO_CANDIDATES"
  | "ALL_DEAD"
  | "UNKNOWN";
export interface ProviderError {
  code: ErrorCode;
  message: string;
  provider?: string;
  retryable: boolean;
}
export const perr = (
  code: ErrorCode,
  message: string,
  provider?: string,
  retryable = false,
): ProviderError => ({ code, message, provider, retryable });

export interface Ctx {
  timeout: number;
  log?: (m: string) => void;
}
export const ctx = (timeout = 8000): Ctx => ({ timeout });

/* ── 2. safe(): the universal wrapper. Everything provider-side goes through it. ── */
export async function safe<T>(
  fn: () => Promise<T>,
  o: { deadline: number; label: string; provider?: string },
): Promise<Result<T, ProviderError>> {
  try {
    const v = await Promise.race([
      fn(),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(Object.assign(new Error("overrun"), { code: "TIMEOUT" })),
          o.deadline,
        ),
      ),
    ]);
    return ok(v);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const code: ErrorCode = /overrun|timeout|timed out|abort/i.test(m)
      ? "TIMEOUT"
      : /403|401|captcha|challenge|cloudflare/i.test(m)
        ? "BLOCKED"
        : /404|not found/i.test(m)
          ? "NOT_FOUND"
          : "UNKNOWN";
    return err(
      perr(
        code,
        `${o.label}: ${m.slice(0, 160)}`,
        o.provider,
        code === "TIMEOUT",
      ),
    );
  }
}

/* ── 3. HTTP: native fetch + timeout + optional validator. No undici needed. ── */
export interface GetOpts {
  timeout?: number;
  headers?: Record<string, string>;
  validate?: (u: unknown) => unknown;
}
export async function getJSON<T>(
  url: string,
  o: GetOpts = {},
): Promise<Result<T, ProviderError>> {
  try {
    const v = await traced("GET json", url, async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(o.timeout ?? 8000),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36",
          accept: "application/json",
          ...(o.headers ?? {}),
        },
      });
      const body = (await res.text()).slice(0, 2_000_000);
      let j: unknown;
      try {
        j = JSON.parse(body);
      } catch {
        throw Object.assign(
          new Error(
            `HTTP ${res.status} (non-JSON body: ${body.slice(0, 120)})`,
          ),
          { status: res.status },
        );
      }
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      return {
        status: res.status,
        bytes: body.length,
        value: (o.validate ? o.validate(j) : j) as T,
      };
    });
    return ok(v);
  } catch (e) {
    const st = (e as { status?: number }).status;
    const msg = e instanceof Error ? e.message : String(e);
    if (st === 404)
      return err(perr("NOT_FOUND", `HTTP 404 ${url.slice(0, 90)}`));
    return err(
      perr(
        /abort|timeout|Timeout/i.test(msg) ? "TIMEOUT" : "UNKNOWN",
        `${msg.slice(0, 140)} ← ${url.slice(0, 80)}`,
        undefined,
        st !== undefined && st >= 500,
      ),
    );
  }
}

export async function getText(
  url: string,
  o: Omit<GetOpts, "validate"> = {},
): Promise<Result<string, ProviderError>> {
  try {
    const t = await traced("GET html", url, async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(o.timeout ?? 8000),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36",
          ...(o.headers ?? {}),
        },
      });
      if (!res.ok)
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      const body = await res.text();
      return { status: res.status, bytes: body.length, value: body };
    });
    return ok(t);
  } catch (e) {
    const st = (e as { status?: number }).status;
    const msg = e instanceof Error ? e.message : String(e);
    if (st === 404)
      return err(perr("NOT_FOUND", `HTTP 404 ${url.slice(0, 90)}`));
    return err(
      perr(
        /abort|timeout|Timeout/i.test(msg) ? "TIMEOUT" : "UNKNOWN",
        `${msg.slice(0, 140)} ← ${url.slice(0, 80)}`,
        undefined,
        true,
      ),
    );
  }
}

/* ── 4. resilience: breaker + cache + per-host limiter ──────────────────── */
type State = "closed" | "open" | "half-open";
const breakers = new Map<
  string,
  { fails: number; state: State; openedAt: number }
>();
export const breaker = {
  state(k: string): State {
    return breakers.get(k)?.state ?? "closed";
  },
  async run<T>(
    key: string,
    fn: () => Promise<Result<T, ProviderError>>,
  ): Promise<Result<T, ProviderError>> {
    const b = breakers.get(key) ?? {
      fails: 0,
      state: "closed" as State,
      openedAt: 0,
    };
    breakers.set(key, b);
    if (b.state === "open") {
      if (Date.now() - b.openedAt < 60_000)
        return err(perr("BLOCKED", `breaker open: ${key}`, undefined, false));
      b.state = "half-open";
    }
    const r = await fn();
    if (r.ok) {
      b.fails = 0;
      b.state = "closed";
    } else if (++b.fails >= 5) {
      b.state = "open";
      b.openedAt = Date.now();
    }
    return r;
  },
};

const mem = new Map<string, { v: unknown; exp: number }>();
const flying = new Map<string, Promise<unknown>>();
export function cacheKey(...parts: (string | number)[]): string {
  return parts.join("|");
}
/* drop expired entries + cap size: called on every prober tick so the
   cache never grows without bound on a long-lived server. */
export function pruneCache(): number {
  const now = Date.now();
  let n = 0;
  for (const [k, v] of mem) {
    if (v.exp <= now) {
      mem.delete(k);
      n++;
    }
  }
  if (mem.size > 2000) {
    mem.clear();
    n += 2000;
  }
  flying.clear();
  return n;
}
export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = mem.get(key);
  if (hit && hit.exp > Date.now()) return hit.v as T;
  let f = flying.get(key) as Promise<T> | undefined; // single-flight: no stampede
  if (!f) {
    f = fn().finally(() => {
      flying.delete(key);
    });
    flying.set(key, f);
    if (mem.size > 2000) mem.clear();
  }
  const v = await f;
  mem.set(key, { v, exp: Date.now() + ttlMs });
  return v;
}

/* per-HOST semaphore, FIFO — sites share hosts (wing.st, vidrift, TMDB). */
const queues = new Map<string, Array<() => void>>();
const active = new Map<string, number>();
const PER_HOST = 4;
export const limit = {
  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((res) => {
      const q = queues.get(host) ?? [];
      queues.set(host, q);
      q.push(res);
      if ((active.get(host) ?? 0) < PER_HOST) {
        active.set(host, (active.get(host) ?? 0) + 1);
        q.shift()?.();
      }
    });
    try {
      return await fn();
    } finally {
      const q = queues.get(host) ?? [];
      const next = q.shift();
      if (next) next();
      else active.set(host, (active.get(host) ?? 1) - 1);
    }
  },
};
export const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "unknown";
  }
};
export const limitedGetJSON = <T>(url: string, o?: GetOpts) =>
  limit.run(hostOf(url), () => getJSON<T>(url, o));
export const limitedGetText = (url: string, o?: Omit<GetOpts, "validate">) =>
  limit.run(hostOf(url), () => getText(url, o));

/* ── tracer: every HTTP call recorded when enabled (chitra --trace).
        Zero-cost when off: a single boolean check per request. ── */
export interface TraceEvent {
  t: number;
  op: string;
  url: string;
  status?: number;
  ms?: number;
  bytes?: number;
  error?: string;
}
let tracing = false;
const traceEvents: TraceEvent[] = [];
export const trace = {
  on() {
    tracing = true;
    traceEvents.length = 0;
  },
  off() {
    tracing = false;
  },
  events(): TraceEvent[] {
    return [...traceEvents];
  },
  push(e: Omit<TraceEvent, "t">) {
    if (tracing && traceEvents.length < 300)
      traceEvents.push({ ...e, t: Date.now() });
  },
};
async function traced<T>(
  op: string,
  url: string,
  fn: () => Promise<{ status?: number; bytes?: number; value: T }>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    trace.push({
      op,
      url: url.slice(0, 160),
      status: r.status,
      ms: Date.now() - t0,
      bytes: r.bytes,
    });
    return r.value;
  } catch (e) {
    trace.push({
      op,
      url: url.slice(0, 160),
      ms: Date.now() - t0,
      error: String(e).slice(0, 120),
    });
    throw e;
  }
}

/* ── 5. fan-out: first-N-wins, never Promise.all. ── */
type Task<T> = () => Promise<Result<T, ProviderError>>;

/* Parse every variant of an HLS master manifest, best-first. Emitting one
   link per variant is how "all available qualities" reaches the user. */
export interface HlsVariant {
  resolution: string;
  bandwidth: number;
  name?: string;
}
export function parseHlsVariants(text: string): HlsVariant[] {
  const out: HlsVariant[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const inf = lines[i] ?? "";
    if (!inf.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number(/BANDWIDTH=(\d+)/i.exec(inf)?.[1] ?? 0);
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(inf);
    const nm = /NAME="([^"]+)"/i.exec(inf)?.[1];
    const w = res ? Number(res[1]) : 0;
    out.push({
      resolution:
        w >= 3800
          ? "4K"
          : w >= 1900
            ? "1080p"
            : w >= 1280
              ? "720p"
              : w >= 800
                ? "480p"
                : w > 0
                  ? "360p"
                  : normRes(nm ?? ""),
      bandwidth: bw,
      name: nm,
    });
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}

/* First-N-wins fan-out: resolve when `enough` successes are collected instead
   of draining every provider. This is what makes /stream fast — Stremio gets
   links as soon as enough providers answer, slow ones don't hold the response. */
export async function raceUntil<T>(
  tasks: Task<T>[],
  o: { timeout: number; concurrency: number; enough: number },
): Promise<Result<T[], ProviderError>> {
  const out: T[] = [];
  const queue = [...tasks];
  let stopped = false;
  const stop = setTimeout(() => {
    stopped = true;
  }, o.timeout);
  const workers = Array.from(
    { length: Math.min(Math.max(o.concurrency, 1), Math.max(tasks.length, 1)) },
    async () => {
      while (queue.length && !stopped) {
        if (out.length >= o.enough) {
          stopped = true;
          break;
        }
        const t = queue.shift();
        if (!t) break;
        try {
          const r = await t();
          if (r.ok) out.push(r.value);
        } catch {
          /* safe() already wrapped */
        }
      }
    },
  );
  await Promise.all(workers);
  clearTimeout(stop);
  return out.length
    ? ok(out)
    : err(perr("ALL_DEAD", "no provider produced a result"));
}

/* bounded parallelism that preserves order: probe N candidates, at most
   `limit` in flight. The main performance win — qs loops were sequential. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T, i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/* ── 6. identity: every site is TMDB-keyed, Stremio speaks IMDb. ────────── */
export interface ParsedId {
  imdb?: string;
  tmdb?: number;
  season?: number;
  episode?: number;
}
export function parseStremioId(id: string): ParsedId {
  const parts = id.split(":");
  const head = parts[0] ?? "";
  const s = parts[1];
  const e = parts[2];
  const p: ParsedId = {};
  if (head.startsWith("tt")) p.imdb = head;
  else if (/^\d+$/.test(head)) p.tmdb = Number(head);
  if (s !== undefined) p.season = Number(s);
  if (e !== undefined) p.episode = Number(e);
  return p;
}
const TMDB = "https://api.themoviedb.org/3";
/* Default key baked in so nobody is ever asked for one; env overrides. */
const tmdbKey = () =>
  process.env.TMDB_API_KEY ?? "439c478a771f35c05022f9feabcca01c";
/** where the effective key comes from — the user is never asked for one. */
export function tmdbKeySource(): "env" | "built-in" {
  return process.env.TMDB_API_KEY ? "env" : "built-in";
}
export async function imdbToTmdb(
  imdb: string,
): Promise<Result<number, ProviderError>> {
  if (!tmdbKey())
    return err(
      perr("NEEDS_TMDB_KEY", "set TMDB_API_KEY — this site only speaks tmdb"),
    );
  const r = await limitedGetJSON<{
    movie_results: { id: number }[];
    tv_results: { id: number }[];
  }>(`${TMDB}/find/${imdb}?external_source=imdb_id&api_key=${tmdbKey()}`, {
    timeout: 6000,
  });
  if (!r.ok) return r;
  const id = r.value.movie_results[0]?.id ?? r.value.tv_results[0]?.id;
  return id ? ok(id) : err(perr("NOT_FOUND", `no tmdb match for ${imdb}`));
}
export async function tmdbToImdb(
  tmdb: number,
  type: "movie" | "series",
): Promise<Result<string, ProviderError>> {
  if (!tmdbKey()) return err(perr("NEEDS_TMDB_KEY", "set TMDB_API_KEY"));
  const kind = type === "movie" ? "movie" : "tv";
  const r = await limitedGetJSON<{ imdb_id: string }>(
    `${TMDB}/${kind}/${tmdb}/external_ids?api_key=${tmdbKey()}`,
    { timeout: 6000 },
  );
  if (!r.ok) return r;
  return r.value.imdb_id
    ? ok(r.value.imdb_id)
    : err(perr("NOT_FOUND", `no imdb for tmdb:${tmdb}`));
}
/** normalize caller keys to what the site accepts (converting via TMDB when needed). */
/* Full title resolution: imdb / tmdb / name in, normalized keys out.
   Order: direct keys → keyless site paths stay in providers → TMDB API (needs
   key) → clear error naming exactly what's missing. Name search without a key
   is the one case that cannot be solved — the error says so. */
export interface TitleKeys {
  type: "movie" | "series";
  imdb?: string;
  tmdb?: number;
  name?: string;
  year?: number;
}
export interface ResolvedTitle {
  imdb?: string;
  tmdb?: number;
  title?: string;
  year?: number;
}
export async function resolveTitle(
  q: TitleKeys,
  supports: { imdb: boolean; tmdb: boolean },
  provider: string,
): Promise<Result<ResolvedTitle, ProviderError>> {
  let { imdb, tmdb } = q;
  let title = q.name;
  let year = q.year;
  if (tmdb) {
    if (!supports.tmdb && !imdb) {
      const c = await tmdbToImdb(tmdb, q.type);
      if (!c.ok) return err({ ...c.error, provider });
      imdb = c.value;
    }
    return ok({ imdb, tmdb, title, year });
  }
  if (imdb) {
    if (!supports.imdb && !tmdb) {
      const c = await imdbToTmdb(imdb);
      if (!c.ok) return err({ ...c.error, provider });
      tmdb = c.value;
    }
    return ok({ imdb, tmdb, title, year });
  }
  if (q.name) {
    if (!tmdbKey()) {
      return err(
        perr(
          "NEEDS_TMDB_KEY",
          `name search "${q.name}" needs TMDB_API_KEY (or pass imdb/tmdb directly)`,
          provider,
        ),
      );
    }
    const kind = q.type === "movie" ? "movie" : "tv";
    const y = q.year
      ? kind === "movie"
        ? `&year=${q.year}`
        : `&first_air_date_year=${q.year}`
      : "";
    const r = await limitedGetJSON<{
      results?: {
        id: number;
        title?: string;
        name?: string;
        release_date?: string;
        first_air_date?: string;
      }[];
    }>(
      `${TMDB}/search/${kind}?query=${encodeURIComponent(q.name)}${y}&api_key=${tmdbKey()}`,
      { timeout: 7000 },
    );
    if (!r.ok) return err({ ...r.error, provider });
    const hit = (r.value.results ?? [])[0];
    if (!hit)
      return err(perr("NOT_FOUND", `no TMDB match for "${q.name}"`, provider));
    tmdb = hit.id;
    title = hit.title ?? hit.name ?? q.name;
    const d = hit.release_date ?? hit.first_air_date ?? "";
    if (!year && d) year = Number(d.slice(0, 4));
    if (!supports.tmdb && !imdb) {
      const c = await tmdbToImdb(tmdb, q.type);
      if (c.ok) imdb = c.value; // best effort: title resolves even if imdb lookup fails
    }
    return ok({ imdb, tmdb, title, year });
  }
  return err(perr("PARSE", "search needs imdb, tmdb, or name", provider));
}
/* ── 7. stream-name builder: "1080p 2.4GB HIN Nebula". Missing parts are
        OMITTED, never printed as blanks. ──────────────────────────────── */
const RES_ALIASES: [RegExp, string][] = [
  [/2160|4k|uhd/i, "4K"],
  [/1080/i, "1080p"],
  [/720/i, "720p"],
  [/480/i, "480p"],
  [/360|240/i, "360p"],
  [/\bhd\b/i, "HD"],
  [/\bcam\b/i, "CAM"],
];
export function normRes(s?: string | null): string {
  if (!s) return "HD";
  for (const [re, v] of RES_ALIASES) if (re.test(s)) return v;
  const m = /(\d{3,4})p/i.exec(s);
  return m ? m[0].toLowerCase() : "HD";
}
const AUDIO_ALIASES: [RegExp, string][] = [
  [/hindi|\bhin\b/i, "HIN"],
  [/english|\beng\b/i, "ENG"],
  [/tamil|\btam\b/i, "TAM"],
  [/telugu|\btel\b/i, "TEL"],
  [/malayalam|\bmal\b/i, "MAL"],
  [/kannada|\bkan\b/i, "KAN"],
  [/japanese|\bjpn?\b/i, "JPN"],
  [/korean|\bkor\b/i, "KOR"],
];
export function normAudio(...texts: (string | null | undefined)[]): string[] {
  const src = texts
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" | ");
  const found = AUDIO_ALIASES.filter(([re]) => re.test(src)).map(([, c]) => c);
  const uniq = [...new Set(found)];
  if (!uniq.length) return [];
  const pref = ["ENG", "HIN", "TAM", "TEL", "MAL", "KAN", "JPN", "KOR"];
  uniq.sort((a, b) => pref.indexOf(a) - pref.indexOf(b));
  return uniq.length > 2 ? ["MULTI"] : uniq;
}
export function fmtSize(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0,
    v = bytes;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number(v.toFixed(v >= 100 ? 0 : 1))}${u[i]}`;
}
export function streamName(p: {
  resolution?: string | null;
  sizeBytes?: number | null;
  audio?: string[];
  kind?: StreamKind | null;
  provider: string;
}): string {
  const parts = [normRes(p.resolution)];
  const s = fmtSize(p.sizeBytes ?? null);
  if (s) parts.push(s);
  if (p.audio?.length) parts.push(p.audio.join("+"));
  if (p.kind) parts.push(p.kind.toUpperCase());
  parts.push(p.provider);
  return parts.join(" ");
}
/** the contract test enforces this shape on every emitted name. */
export const STREAM_NAME_RE =
  /^(4K|\d{3,4}p|HD|CAM|AUTO)( \d+(\.\d+)? ?[KMGT]B)?( ([A-Z]{3}(\+[A-Z]{3}){0,2}|MULTI))?( (HLS|DASH|DDL))? \S[\s\S]*$/;

/* ── 8. validateStream(): a link is valid only if it FETCHES as media. ────
   hls: url mentions .m3u8 and the body contains #EXTM3U
   dash: url mentions .mpd and the body contains <MPD
   ddl:  200/206 whose content-type is NOT html/json, with size when known   */
export type StreamKind = "hls" | "dash" | "ddl";
export type StreamCheck =
  | { ok: true; kind: StreamKind; sizeBytes: number | null }
  | { ok: false; reason: string };
export async function validateStream(
  url: string,
  timeoutMs = 8000,
): Promise<StreamCheck> {
  const dead = (reason: string): StreamCheck => ({ ok: false, reason });
  try {
    const u = url.toLowerCase();
    const sig = AbortSignal.timeout(timeoutMs);
    trace.push({ op: "probe", url: url.slice(0, 160) });
    if (u.includes(".m3u8")) {
      const r = await fetch(url, {
        headers: { Range: "bytes=0-8191" },
        signal: sig,
      });
      const t = await r.text();
      return t.includes("#EXTM3U")
        ? { ok: true, kind: "hls", sizeBytes: null }
        : dead("m3u8 body has no #EXTM3U");
    }
    if (u.includes(".mpd")) {
      const r = await fetch(url, { signal: sig });
      const t = (await r.text()).slice(0, 4000);
      return t.includes("<MPD")
        ? { ok: true, kind: "dash", sizeBytes: null }
        : dead("mpd body has no <MPD");
    }
    let r = await fetch(url, {
      method: "HEAD",
      signal: sig,
      redirect: "follow",
    });
    if (r.status === 405 || r.status === 403) {
      r = await fetch(url, {
        headers: { Range: "bytes=0-1023" },
        signal: sig,
        redirect: "follow",
      });
    }
    if (r.status !== 200 && r.status !== 206) return dead(`HTTP ${r.status}`);
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    if (/text\/html|application\/json/.test(ct))
      return dead(`content-type ${ct || "missing"} is not media`);
    /* proxies hide HLS/DASH behind extensionless URLs — sniff the first bytes
       instead of trusting the extension or an ambiguous content-type. */
    if (
      !/\.(m3u8|mpd)(\?|$)/i.test(url) &&
      !/video\/|audio\/|mpegurl|mpd|dash|\/mp4|octet-stream|binary/.test(ct)
    ) {
      try {
        const probe = await fetch(url, {
          headers: { Range: "bytes=0-2047" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
        const head = await probe.text();
        if (head.includes("#EXTM3U"))
          return { ok: true, kind: "hls", sizeBytes: null };
        if (head.includes("<MPD"))
          return { ok: true, kind: "dash", sizeBytes: null };
        if (/<!doctype html|<html/i.test(head.slice(0, 400)))
          return dead("body is HTML, not media");
      } catch {
        /* sniff failed — fall through to the HEAD verdict */
      }
    }
    const len = Number(
      r.headers.get("content-length") ??
        r.headers.get("content-range")?.split("/")[1] ??
        NaN,
    );
    return {
      ok: true,
      kind: "ddl",
      sizeBytes: Number.isFinite(len) ? len : null,
    };
  } catch (e) {
    return dead(`fetch failed: ${String(e).slice(0, 100)}`);
  }
}

/* pull candidate media URLs out of arbitrary HTML/JSON text — shared fallback
   for sites with no documented resolve endpoint. Everything it returns is
   UNVALIDATED; only emit after validateStream(). */
export function extractCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|mkv|webm)(?:\?[^\s"'<>\\]*)?/gi,
  ))
    out.add(m[0]);
  for (const m of text.matchAll(
    /"(?:url|file|src|source|manifest|playbackUrl)"\s*:\s*"(https?:\/\/[^"]{8,300})"/gi,
  )) {
    const u = m[1];
    if (u && /\.(m3u8|mpd|mp4|mkv|webm)(\?|$)/i.test(u)) out.add(u);
  }
  return [...out].slice(0, 12);
}
