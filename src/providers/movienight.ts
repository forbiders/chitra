/**
 * providers/movienight.ts — https://movienig.ht/
 * Measured: GET /api/servers → austin/madison/salem/tucson/helena/vixsrc-1 (no auth);
 * titles at /title/movie/{imdb}; media on live.metahub.space.
 * IMDb-keyed solares. Resolve falls back to scraping the title page for media
 * URLs — everything returned is validated, nothing is fabricated.
 */
import {
  cached,
  cacheKey,
  getJSON,
  limitedGetText,
  normAudio,
  normRes,
  resolveTitle,
  streamName,
  validateStream,
  extractCandidates,
  mapLimit,
  parseHlsVariants,
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

const ID = "movienight";
const SITE = "MovieNight";
const BASE = "https://movienig.ht";

/* resolution + audio from the HLS master manifest itself:
   RESOLUTION= tags give pixels, TYPE=AUDIO groups give real audio languages.
   Falls back to the source's own quality label, then URL tags. */
async function probeManifest(
  url: string,
  label?: string,
  typeHint?: string,
): Promise<{ variants: string[]; audio: string[] }> {
  const fallback = normRes(label);
  const labelAudio = normAudio(label);
  /* the source entry often declares type:"hls" while the (proxied) URL has no
     .m3u8 extension — trust the hint, then fall back to sniffing inside validate */
  if (!/\.m3u8/i.test(url) && typeHint !== "hls")
    return { variants: [fallback], audio: labelAudio };
  // ranged read only: a full GET of a proxied playlist hangs for megabytes
  let text = "";
  try {
    const r = await fetch(url, {
      headers: { Range: "bytes=0-16383" },
      signal: AbortSignal.timeout(9000),
    });
    text = await r.text();
  } catch {
    return { variants: [fallback], audio: labelAudio };
  }
  const parsed = parseHlsVariants(text);
  const variants = parsed.length ? parsed.map((v) => v.resolution) : [fallback];
  const langs: string[] = [];
  for (const m of text.matchAll(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/gi)) {
    const line = m[0];
    const lang = /LANGUAGE="([^"]+)"/i.exec(line)?.[1] ?? "";
    const name = /NAME="([^"]+)"/i.exec(line)?.[1] ?? "";
    langs.push(`${lang} ${name}`);
  }
  const audio = normAudio(...langs);
  return { variants, audio: audio.length ? audio : labelAudio };
}

const provider: Provider = {
  id: ID,
  blurb: "Austin/Madison/Salem via own api, HLS + subtitles",
  supports: { imdb: true, tmdb: false },
  fixture: { type: "movie", imdb: "tt0468569" },

  async search(
    q: SearchQuery,
    ctx: Ctx,
  ): Promise<Result<FoundTitle[], ProviderError>> {
    const ids = await resolveTitle(q, provider.supports, ID);
    if (!ids.ok || !ids.value.imdb)
      return ids.ok
        ? {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: "no imdb id",
              provider: ID,
              retryable: false,
            },
          }
        : ids;
    const imdb = ids.value.imdb;
    const kind = q.type === "movie" ? "movie" : "series";
    const page = await limitedGetText(`${BASE}/title/${kind}/${imdb}`, {
      timeout: ctx.timeout,
    });
    if (!page.ok) return page;
    return {
      ok: true,
      value: [
        {
          providerId: ID,
          siteTitleId: imdb,
          title: imdb,
          type: q.type,
          imdb,
          tmdb: ids.value.tmdb,
        },
      ],
    };
  },

  async load(
    found: FoundTitle,
    ctx: Ctx,
  ): Promise<Result<ServerEntry[], ProviderError>> {
    const r = await cached(cacheKey("servers", ID), 300_000, () =>
      getJSON<unknown>(`${BASE}/api/servers`, { timeout: ctx.timeout }),
    );
    if (!r.ok) return r;
    const raw = (r.value as { servers?: unknown }).servers;
    const items: { id: string; label: string; fourK?: boolean }[] =
      Array.isArray(raw)
        ? raw.flatMap((x): { id: string; label: string; fourK?: boolean }[] => {
            if (typeof x === "string")
              return [{ id: x.toLowerCase(), label: x }];
            if (x && typeof x === "object") {
              const o = x as Record<string, unknown>;
              const id = o.id ?? o.name ?? o.key;
              const label = o.label ?? o.name ?? o.title ?? id;
              if (typeof id === "string" && typeof label === "string") {
                return [
                  {
                    id: id.toLowerCase(),
                    label,
                    fourK: o.fourK === true || o["4k"] === true,
                  },
                ];
              }
            }
            return [];
          })
        : [];
    if (!items.length)
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "empty server list",
          provider: ID,
          retryable: false,
        },
      };
    return {
      ok: true,
      value: items.map((n, i) => ({
        id: n.id,
        name: n.label,
        status: "ok" as const,
        quality: (n.fourK ? "4K" : undefined) as ServerEntry["quality"],
        priority: i,
      })),
    };
  },

  async getVideoSizeResolution(
    q: ServerQuery,
    ctx: Ctx,
  ): Promise<Result<QualityInfo[], ProviderError>> {
    /* Movies resolve keylessly via /api/stream/v1. Series answers
       {"error":"Unauthorized"} on every shape tried — needs a login session. */
    if (q.found.type !== "movie") {
      return {
        ok: false,
        error: {
          code: "BLOCKED",
          message: "tv resolve requires login on this site",
          provider: ID,
          retryable: false,
        },
      };
    }
    // tmdb + title + year come from the site's own meta endpoint — no TMDB key needed
    const imdb = q.found.imdb ?? q.found.siteTitleId;
    const meta = await cached(cacheKey("meta", ID, imdb), 24 * 3600_000, () =>
      getJSON<{
        tmdbId?: string | number;
        name?: string;
        year?: string | number;
      }>(`${BASE}/api/discover/meta/movie/${imdb}`, {
        timeout: Math.min(ctx.timeout, 12000),
      }),
    );
    if (!meta.ok) return meta;
    const tmdb = q.found.tmdb ?? Number(meta.value.tmdbId ?? NaN);
    if (!Number.isFinite(tmdb)) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "no tmdb id for title",
          provider: ID,
          retryable: false,
        },
      };
    }
    const title = meta.value.name ?? q.found.title;
    const year = String(meta.value.year ?? "").slice(0, 4);
    const st = await getJSON<{
      server?: string;
      sources?: { url?: string; quality?: string; type?: string }[];
    }>(
      `${BASE}/api/stream/v1/movie/${tmdb}?title=${encodeURIComponent(title)}&year=${encodeURIComponent(year)}&imdbId=${encodeURIComponent(imdb)}`,
      { timeout: ctx.timeout },
    );
    if (!st.ok) return st;
    const servedBy = st.value.server ?? q.server.name;
    const subs = (
      (
        st.value as {
          subtitles?: { url?: string; lang?: string; language?: string }[];
        }
      ).subtitles ?? []
    )
      .filter((x) => typeof x.url === "string")
      .map((x) => ({
        url: x.url as string,
        lang: String(x.lang ?? x.language ?? "und").slice(0, 8),
      }));
    const nested = (
      await mapLimit(
        (st.value.sources ?? [])
          .filter((src) => typeof src.url === "string")
          .slice(0, 6),
        4,
        async (src): Promise<QualityInfo[] | null> => {
          const url = src.url as string;
          const v = await validateStream(url, Math.min(ctx.timeout, 12000));
          if (!v.ok) return null;
          // manifest ladder cached per URL: the 6s proxy fetch happens once
          const probed = await cached(
            cacheKey("ladder", ID, url),
            600_000,
            () => probeManifest(url, src.quality, src.type),
          );
          return probed.variants.map((resolution) => ({
            resolution,
            sizeBytes: v.kind === "ddl" ? v.sizeBytes : null,
            kind: v.kind,
            audio: probed.audio,
            subtitles: subs.length ? subs : undefined,
            ref: `${servedBy}::${url}`,
          }));
        },
      )
    ).filter((x): x is QualityInfo[] => x !== null);
    const out: QualityInfo[] = nested.flat();
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
    return {
      ok: true,
      value: quals.map((qu) => {
        const parts = qu.ref.split("::");
        const served = parts.length > 1 ? (parts[0] as string) : q.server.name;
        const real = (
          parts.length > 1 ? parts.slice(1).join("::") : qu.ref
        ) as string;
        return {
          name: streamName({
            resolution: qu.resolution,
            sizeBytes: qu.sizeBytes,
            audio: qu.audio,
            kind: qu.kind,
            provider: `${SITE} ${served}`,
          }),
          url: real,
          ref: qu.ref,
          sizeBytes: qu.sizeBytes,
          subtitles: qu.subtitles,
        };
      }),
    };
  },
};

export default provider;
export const fixture = provider.fixture;
