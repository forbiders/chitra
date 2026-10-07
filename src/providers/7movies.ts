/**
 * providers/7movies.ts — https://7movies.ac/
 * Measured: player backend embed.vidrift.net; switcher "Switch to Titan/Earth/Atlas",
 * "Earth — Testing"; GET /api/boot/{type}/{id} → {meta:{playbackToken,hint,orionStreams}}
 * then GET /api/source/{type}/{id}?token= → {provider,source,streams:[{provider,url}]}.
 * TMDB-keyed (/movie/{tmdbId}, /tv/{tmdbId}?season=&episode=).
 */
import {
  cached,
  cacheKey,
  getJSON,
  getText,
  normAudio,
  normRes,
  resolveTitle,
  streamName,
  validateStream,
  mapLimit,
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

const ID = "7movies";
const SITE = "7Movies";
const EMBED = "https://embed.vidrift.net";

interface BootMeta {
  playbackToken?: string;
  hint?: string;
  orionStreams?: {
    provider?: string;
    url?: string;
    rungs?: { width?: number }[];
  }[];
}
interface Boot {
  meta?: BootMeta;
}
interface SrcStream {
  provider?: string;
  url?: string;
  proxyUrl?: string;
  maxRes?: number;
  quality?: string;
  label?: string;
  rungs?: { width?: number }[];
}
interface Src {
  streams?: SrcStream[];
  source?: string;
  provider?: string;
  maxRes?: number;
}

const abs = (u: string) => {
  try {
    return new URL(u, EMBED + "/").href;
  } catch {
    return u;
  }
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function widthsToRes(widths: number[]): string | null {
  const w = Math.max(0, ...widths);
  if (!w) return null;
  if (w >= 3800) return "4K";
  if (w >= 1900) return "1080p";
  if (w >= 1280) return "720p";
  if (w >= 800) return "480p";
  return "360p";
}

/* every "provider":"X" string in the boot payload is a candidate server */
function bootProviders(b: Boot): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (
        typeof o.provider === "string" &&
        /^[A-Za-z][\w .·-]{1,24}$/.test(o.provider)
      ) {
        const first = o.provider.split(/[ ·]/)[0];
        if (first) out.push(first);
      }
      for (const x of Object.values(o)) walk(x);
    }
  };
  walk(b);
  if (b.meta?.hint) out.push(b.meta.hint);
  return [...new Set(out)].filter(
    (s) => !/^(vaplayer|movie|tv|hd|auto)$/i.test(s),
  );
}

async function boot(
  tmdb: number,
  type: "movie" | "tv",
  ctx: Ctx,
  season?: number,
  episode?: number,
): Promise<Result<Boot, ProviderError>> {
  /* series inserts /{season}/{episode} into boot+source paths (measured:
     /api/boot/tv/2190/1/1?...&season=1&episode=1). Defaults to S1E1. */
  const path =
    type === "movie"
      ? `movie/${tmdb}`
      : `tv/${tmdb}/${season ?? 1}/${episode ?? 1}`;
  const extra =
    type === "movie" ? "" : `&season=${season ?? 1}&episode=${episode ?? 1}`;
  return cached(cacheKey("boot", ID, path), 180_000, () =>
    getJSON<Boot>(
      `${EMBED}/api/boot/${path}?type=${type}&id=${tmdb}${extra}&source=0`,
      { timeout: ctx.timeout },
    ),
  );
}

const provider: Provider = {
  id: ID,
  blurb: "Orion/Earth/Star/Atlas/Titan via vidrift embed",
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
    const b = await boot(tmdb, q.type === "movie" ? "movie" : "tv", ctx);
    if (!b.ok) return b;
    if (!b.value.meta?.playbackToken)
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "title has no playback session",
          provider: ID,
          retryable: false,
        },
      };
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
    const tmdb = Number(found.siteTitleId);
    const b = await boot(tmdb, found.type === "movie" ? "movie" : "tv", ctx);
    if (!b.ok) return b;
    const names = bootProviders(b.value);
    if (!names.length)
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "no providers in boot payload",
          provider: ID,
          retryable: false,
        },
      };
    return {
      ok: true,
      value: names.map((n, i) => ({
        id: slug(n),
        name: n,
        status: "ok" as const,
        priority: i,
      })),
    };
  },

  async getVideoSizeResolution(
    q: ServerQuery,
    ctx: Ctx,
  ): Promise<Result<QualityInfo[], ProviderError>> {
    const tmdb = Number(q.found.siteTitleId);
    const type = q.found.type === "movie" ? "movie" : "tv";
    const b = await boot(tmdb, type, ctx, q.season, q.episode);
    if (!b.ok) return b;
    const token = b.value.meta?.playbackToken;
    if (!token)
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "no playback token",
          provider: ID,
          retryable: false,
        },
      };
    /* NOTE: /api/source ignores selection params (a provider= value 502s) and
       returns whatever source is currently available. Output is labeled with the
       ACTUAL serving source from the response, not the requested server. */
    const srcPath =
      type === "movie"
        ? `movie/${tmdb}`
        : `tv/${tmdb}/${q.season ?? 1}/${q.episode ?? 1}`;
    const s = await getJSON<Src>(
      `${EMBED}/api/source/${srcPath}?token=${encodeURIComponent(token)}`,
      { timeout: ctx.timeout },
    );
    if (!s.ok) return s;
    const servedBy = s.value.source ?? s.value.provider ?? q.server.name;
    const envelopeRes = s.value.maxRes ? `${s.value.maxRes}p` : null;
    const use = s.value.streams ?? [];
    const probed = await mapLimit(
      use
        .filter(
          (st) => typeof st.url === "string" || typeof st.proxyUrl === "string",
        )
        .slice(0, 6),
      4,
      async (st): Promise<QualityInfo | null> => {
        /* playable URL lives in url, or proxyUrl when url is empty */
        const raw = st.url || st.proxyUrl;
        if (!raw) return null;
        const url = abs(raw);
        const v = await validateStream(url, Math.min(ctx.timeout, 9000));
        if (!v.ok) return null;
        const res =
          widthsToRes((st.rungs ?? []).map((r) => r.width ?? 0)) ??
          (st.maxRes ? `${st.maxRes}p` : null) ??
          st.quality ??
          envelopeRes ??
          null;
        const label = [servedBy, st.provider, st.label, st.quality]
          .filter(Boolean)
          .join(" ");
        return {
          resolution: normRes(res ?? label),
          sizeBytes: v.kind === "ddl" ? v.sizeBytes : null,
          kind: v.kind,
          audio: normAudio(label, url),
          ref: `${servedBy}::${url}`,
        } as QualityInfo;
      },
    );
    const out: QualityInfo[] = probed.filter(
      (x): x is QualityInfo => x !== null,
    );
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
