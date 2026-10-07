/**
 * providers/_template.ts — THE contract. Copy this file to start a new site.
 *
 * Four functions, always in this order. Each returns a Result — never throw.
 * A provider is only as good as getStreams(): it must return ONLY links that
 * passed validateStream(). The contract test (test/providers.contract.test.ts)
 * enforces the whole chain end to end.
 */
import type { Ctx, Result, ProviderError } from "../lib.js";

export type MediaType = "movie" | "series";

/** 1 — find the title on THIS site. Caller passes whichever key it has. */
export interface SearchQuery {
  type: MediaType;
  imdb?: string; // 'tt0468569'
  tmdb?: number; // 155
  name?: string; // 'The Dark Knight' — resolved via TMDB (needs key) or the site itself
  year?: number;
}

export interface FoundTitle {
  providerId: string; // matches the file's id
  siteTitleId: string; // the site's own id for it (tmdb id, slug, tt…)
  title: string;
  year?: number;
  type: MediaType;
  imdb?: string;
  tmdb?: number;
}

/** 2 — start the scrape for a found title: list its extraction servers. */
export interface ServerEntry {
  id: string; // 'nebula' — passed back into qs/streams
  name: string; // 'Nebula' — display name
  status: "ok" | "testing" | "down";
  quality?: "4K" | "HD";
  priority: number; // lower = try first
}

export interface ServerQuery {
  found: FoundTitle;
  server: ServerEntry;
  season?: number; // series only
  episode?: number; // series only
}

/** 3 — resolution AND size in one pass (never two requests when one suffices). */
export interface QualityInfo {
  resolution: string; // '1080p' (or '4K'/'HD' when exact res is unknown)
  sizeBytes: number | null; // null for HLS/live — never fabricate a number
  audio: string[]; // normalized 3-letter codes, e.g. ['HIN','ENG']
  kind: "hls" | "dash" | "ddl"; // link type — shown in the name between audio and provider
  subtitles?: { url: string; lang: string }[]; // discovered alongside — passed through to output
  ref: string; // opaque handle getStreams() redeems — usually the candidate URL
}

/** 4 — fire the final links. Reuse `qualities` when given, else probe once. */
export interface StreamQuery extends ServerQuery {
  qualities?: QualityInfo[];
}

export interface StreamLink {
  /** "1080p 2.4GB HIN Nebula" — built with streamName(), never hand-rolled. */
  name: string;
  url: string;
  ref?: string;
  /** playback headers (Referer/UA) when the host requires them — nuvio pattern. */
  headers?: Record<string, string>;
  /** exact byte size when known (DDL) — sent as Stremio videoSize. */
  sizeBytes?: number | null;
  /** subtitle tracks discovered alongside the stream (url + lang code). */
  subtitles?: { url: string; lang: string }[];
}

export interface Provider {
  readonly id: string;
  /** one-line card description, e.g. "4 extraction servers, HLS via wing.st". */
  readonly blurb: string;
  /** cache TTL for this provider's resolve() results (WebStreamrMBG pattern). */
  readonly ttlMs?: number;
  /** bump to invalidate this provider's cache without touching others. */
  readonly cacheVersion?: number;
  /** which key types this site accepts (conversion happens in lib.resolveTitle). */
  readonly supports: { imdb: boolean; tmdb: boolean };
  /** a title known to exist here — the contract test + prober run against it.
      Include tmdb when the site is tmdb-native so probes never pay conversion. */
  readonly fixture: { type: MediaType; imdb: string; tmdb?: number };
  search(
    q: SearchQuery,
    ctx: Ctx,
  ): Promise<Result<FoundTitle[], ProviderError>>;
  load(
    found: FoundTitle,
    ctx: Ctx,
  ): Promise<Result<ServerEntry[], ProviderError>>;
  getVideoSizeResolution(
    q: ServerQuery,
    ctx: Ctx,
  ): Promise<Result<QualityInfo[], ProviderError>>;
  getStreams(
    q: StreamQuery,
    ctx: Ctx,
  ): Promise<Result<StreamLink[], ProviderError>>;
}
