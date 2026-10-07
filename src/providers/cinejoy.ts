/**
 * providers/cinejoy.ts — https://cinejoy.pk/
 * Measured: GET api.wing.st/servers → Nebula/Lisbon/Solara/Athens (+4k flag);
 * Nebula streams from nebula.bright67.online (/hls/<uuid>/master.m3u8);
 * title info at api.wing.st/info?type=&tmdb=. TMDB-keyed.
 */
import {
  cached,
  cacheKey,
  getJSON,
  getText,
  limitedGetText,
  normAudio,
  normRes,
  resolveTitle,
  streamName,
  validateStream,
  mapLimit,
  trace,
} from "../lib.js";
import type { Ctx, Result, ProviderError } from "../lib.js";
import type {
  Provider,
  SearchQuery,
  FoundTitle,
  ServerEntry,
  ServerQuery,
  StreamQuery,
  QualityInfo,
  StreamLink,
} from "./_template.js";

const ID = "cinejoy";
const SITE = "Cinejoy";
const API = "https://api.wing.st";

/* the /info payload shape drifts — walk anything for media URLs instead of trusting keys */
function walkMedia(
  v: unknown,
  out: { url: string; label?: string }[] = [],
): { url: string; label?: string }[] {
  if (typeof v === "string") {
    if (/^https?:\/\/\S+\.(m3u8|mpd|mp4|mkv|webm)(\?\S*)?$/i.test(v))
      out.push({ url: v });
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) walkMedia(x, out);
    return out;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const url = ["url", "file", "src", "source", "manifest", "playbackUrl"]
      .map((k) => o[k])
      .find((x): x is string => typeof x === "string" && x.startsWith("http"));
    if (url && /\.(m3u8|mpd|mp4|mkv|webm)(\?|$)/i.test(url)) {
      const label = ["label", "quality", "name", "provider", "lang", "language"]
        .map((k) => o[k])
        .find((x): x is string => typeof x === "string");
      out.push({ url, label });
    } else for (const x of Object.values(o)) walkMedia(x, out);
  }
  return out;
}

function widthToRes(w: number): string {
  if (w >= 3800) return "4K";
  if (w >= 1900) return "1080p";
  if (w >= 1280) return "720p";
  if (w >= 800) return "480p";
  return "360p";
}

async function probe(
  url: string,
  label: string | undefined,
  ctx: Ctx,
): Promise<QualityInfo | null> {
  const v = await validateStream(url, Math.min(ctx.timeout, 9000));
  if (!v.ok) return null;
  let resolution: string = normRes(url + " " + (label ?? ""));
  if (v.kind === "hls") {
    const t = await getText(url, { timeout: 8000 });
    if (t.ok) {
      let best = 0;
      for (const m of t.value.matchAll(/RESOLUTION=(\d+)x(\d+)/gi))
        best = Math.max(best, Number(m[1]));
      if (best) resolution = widthToRes(best);
    }
  }
  return {
    resolution,
    sizeBytes: v.kind === "ddl" ? v.sizeBytes : null,

    kind: v.kind,
    audio: normAudio(url, label),
    ref: url,
  };
}

const provider: Provider = {
  id: ID,
  blurb: "Nebula/Lisbon/Solara/Athens via wing.st, HLS + 4K",
  supports: { imdb: false, tmdb: true },
  fixture: { type: "movie", imdb: "tt0468569", tmdb: 155 },

  async search(
    q: SearchQuery,
    ctx: Ctx,
  ): Promise<Result<FoundTitle[], ProviderError>> {
    const ids = await resolveTitle(q, provider.supports, ID);
    if (!ids.ok || !ids.value.tmdb)
      return ids.ok
        ? {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "no tmdb id",
              provider: ID,
              retryable: false,
            },
          }
        : ids;
    const tmdb = ids.value.tmdb;
    const kind = q.type === "movie" ? "movie" : "tv";
    const info = await getJSON<unknown>(
      `${API}/info?type=${kind}&tmdb=${tmdb}`,
      { timeout: ctx.timeout },
    );
    if (!info.ok) return info;
    return {
      ok: true,
      value: [
        {
          providerId: ID,
          siteTitleId: String(tmdb),
          title: `tmdb:${tmdb}`,
          type: q.type,
          imdb: ids.value.imdb,
          tmdb,
        },
      ],
    };
  },

  async load(
    found: FoundTitle,
    ctx: Ctx,
  ): Promise<Result<ServerEntry[], ProviderError>> {
    const r = await cached(cacheKey("servers", ID), 180_000, () =>
      getJSON<{
        servers?: { name?: string; status?: string; "4k"?: boolean }[];
      }>(`${API}/servers`, { timeout: ctx.timeout }),
    );
    if (!r.ok) return r;
    const list = (r.value.servers ?? []).filter(
      (s) => typeof s.name === "string",
    );
    const entries = list.map((s, i) => ({
      id: String(s.name).toLowerCase(),
      name: String(s.name),
      status: (s.status === "ok"
        ? "ok"
        : s.status === "testing"
          ? "testing"
          : "down") as ServerEntry["status"],
      quality: (s["4k"] ? "4K" : undefined) as ServerEntry["quality"],
      priority: i,
    }));
    entries.sort(
      (a, b) =>
        ({ ok: 0, testing: 1, down: 2 })[a.status] -
          { ok: 0, testing: 1, down: 2 }[b.status] || a.priority - b.priority,
    );
    return { ok: true, value: entries };
  },

  async getVideoSizeResolution(
    q: ServerQuery,
    ctx: Ctx,
  ): Promise<Result<QualityInfo[], ProviderError>> {
    const tmdb = q.found.tmdb ?? Number(q.found.siteTitleId);
    if (!Number.isFinite(tmdb))
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "title has no tmdb id",
          provider: ID,
          retryable: false,
        },
      };
    const kind = q.found.type === "movie" ? "movie" : "tv";
    const out: QualityInfo[] = [];
    // fast path: static /info payload
    const info = await cached(cacheKey("info", ID, tmdb), 120_000, () =>
      getJSON<unknown>(`${API}/info?type=${kind}&tmdb=${tmdb}`, {
        timeout: Math.min(ctx.timeout, 12000),
      }),
    );
    if (info.ok) {
      const probed = await mapLimit(walkMedia(info.value).slice(0, 6), 4, (c) =>
        probe(c.url, c.label, ctx),
      );
      for (const p of probed) if (p) out.push(p);
    }
    if (out.length) return { ok: true, value: out };
    // slow path: /info is metadata-only — drive the real player instead
    const watchKind = q.found.type === "movie" ? "movie" : "tv";
    const { scrapePlayer } = await import("../scrape.js");
    const sc = await scrapePlayer({
      url: `https://cinejoy.pk/watch/${watchKind}/${tmdb}`,
      playSelectors: [
        'button:has-text("Play")',
        'button:has-text("Watch")',
        'a:has-text("Play Now")',
      ],
      panelSelectors: [
        'button[aria-label*="Server" i]',
        'button:has-text("Servers")',
        'button:has-text("Server")',
      ],
      serverName: q.server.name,
      timeout: ctx.timeout,
      onEvent: (m) => {
        ctx.log?.(`[browser] ${m}`);
        trace.push({ op: "browser", url: m });
      },
    });
    for (const u of sc.media.slice(0, 6)) {
      const p = await probe(u, q.server.name, ctx);
      if (p) out.push(p);
    }
    return { ok: true, value: out };
  },

  async getStreams(
    q: StreamQuery,
    ctx: Ctx,
  ): Promise<Result<StreamLink[], ProviderError>> {
    let quals = q.qualities;
    if (!quals) {
      const r = await provider.getVideoSizeResolution(q, ctx);
      if (!r.ok) return r;
      quals = r.value;
    } else {
      // externally supplied refs may be stale — re-validate, cheaply and always
      const checked: QualityInfo[] = [];
      for (const qu of quals.slice(0, 8)) {
        const v = await validateStream(qu.ref, 6000);
        if (v.ok)
          checked.push({
            ...qu,
            sizeBytes: v.kind === "ddl" ? v.sizeBytes : qu.sizeBytes,
          });
      }
      quals = checked;
    }
    if (!quals.length)
      return {
        ok: false,
        error: {
          code: "NO_CANDIDATES",
          message: "server returned no playable candidates for this title",
          provider: ID,
          retryable: false,
        },
      };
    const links = quals.map((qu) => ({
      name: streamName({
        resolution: qu.resolution,
        sizeBytes: qu.sizeBytes,
        audio: qu.audio,
        kind: qu.kind,
        provider: `${SITE} ${q.server.name}`,
      }),
      url: qu.ref,
      ref: qu.ref,
      sizeBytes: qu.sizeBytes,
      subtitles: qu.subtitles,
    }));
    return { ok: true, value: links };
  },
};

export default provider;
export const fixture = provider.fixture;
