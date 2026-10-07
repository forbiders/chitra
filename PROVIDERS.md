# Creating providers for Chitra

A provider is one file in `src/providers/` that implements **4 functions**.
Everything else (HTTP, cache, breakers, naming, validation, Stremio wire)
already exists — you only write site knowledge.

- Template: `src/providers/_template.ts` (copy it)
- Contract test: `test/providers.contract.test.ts` (runs every provider)
- Register: one line in `src/registry.ts` (`ALL` map + `ENABLED` list)
- Debug: `npx tsx src/cli.ts <search|load|qs|streams> <site> [keys]`

---

## 1. The 4 functions

```ts
export interface Provider {
  readonly id: string; // 'cinejoy' — matches the registry key
  readonly blurb: string; // one-line card text for the dashboard
  readonly supports: { imdb: boolean; tmdb: boolean };
  readonly fixture: { type: "movie" | "series"; imdb: string; tmdb?: number };
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
```

Rules that are never negotiable:

- **Never throw.** Every function returns `Result<T, ProviderError>`. A bug
  (`null.name`) must come back as `Err(UNKNOWN)`, never as a 500. Use `safe()`
  at every boundary you don't fully control.
- **Never fabricate.** Unknown resolution → `'HD'`. Unknown size (HLS) → `null`,
  omitted from the name. Unknown audio → `[]`. A guessed value in a name is a
  lie the user watches.
- **Empty is an error.** `getStreams` with zero playable candidates returns
  `Err(NO_CANDIDATES)`, not `ok([])` — silence breaks failover, errors continue it.

---

## 2. `search` — imdb / tmdb / name in, site title out

```ts
search({ type: "movie", imdb: "tt0468569" }, ctx);
// → [{ providerId, siteTitleId: '155', title: 'tmdb:155', type, imdb, tmdb }]
```

`siteTitleId` is whatever THIS site uses (tmdb id, slug, tt id). Declare what
the site natively accepts in `supports`, then normalize with one call:

```ts
const ids = await resolveTitle(q, provider.supports, ID);
if (!ids.ok) return ids;
// ids.value = { imdb?, tmdb?, title?, year? }
```

Resolution order inside `resolveTitle` (in `src/lib.ts`):

1. `tmdb` given → use directly (convert to imdb only if the site needs it).
2. `imdb` given → use directly (convert via TMDB only if the site needs it).
3. `name` (+`year`) given → TMDB `/search` → top hit.
4. Nothing usable → `Err(PARSE)` / `Err(NEEDS_TMDB_KEY)` naming exactly what's missing.

The TMDB key is baked into `lib.ts` (env overrides) — nobody is ever asked for
one. Conversions are cached 30 days. Keyless shortcuts stay in the provider:
cinejoy's `/info` returns `imdb_id`, movienight's `/api/discover/meta` returns
`tmdbId` — use the site's own endpoints before paying for conversion.

After resolving, **verify the title exists here** (one cheap request: info page,
boot token, title page 200). `search` returning a title the site doesn't have
wastes every downstream step.

## 3. `load` — start the scrape, list extraction servers

```ts
load(found, ctx);
// → [{ id: 'nebula', name: 'Nebula', status: 'ok', quality: '4K', priority: 0 }, …]
```

- One request, cached minutes (`cached(cacheKey('servers', ID), 180_000, …)`).
- `status`: `'ok'` | `'testing'` | `'down'`. Sort ok-first; the caller tries
  in order.
- `priority`: lower = tried first. Prefer measured-working servers.
- These are the site's OWN servers (Nebula, austin, Earth) — the thing the
  recon measured — not generic hosters.

## 4. `getVideoSizeResolution` — resolution AND size, one pass

```ts
getVideoSizeResolution({ found, server, season?, episode? }, ctx)
// → [{ resolution: '1080p', sizeBytes: null, audio: [], kind: 'hls',
//      ref: 'earth::https://…' }]
```

- **Resolution**: source label → HLS manifest `RESOLUTION=` tags (best variant)
  → URL tags (`1080p`) → `'HD'`. Use `parseHlsVariants()` from lib and emit
  **one QualityInfo per variant** — "all available qualities" means all of them.
- **Size**: DDL only, from `content-length` (the validator returns it). HLS/DASH
  → `null`, always.
- **Audio**: filename tags → HLS `TYPE=AUDIO` groups (`LANGUAGE=`/`NAME=`) →
  source labels, via `normAudio()`. Never subtitles — subtitles are not audio.
- **kind**: set from validation (`hls`/`dash`/`ddl`), shown in the name.
- **ref**: opaque handle `getStreams` redeems. Convention: `servedBy::url`.
- Fetch manifests with **ranged reads** (`Range: bytes=0-16383`), never full
  bodies — a full GET of a proxied playlist hangs for megabytes.
- Probe candidates in parallel (`mapLimit(list, 4, …)`), never sequentially.

## 5. `getStreams` — fire validated links only

```ts
getStreams({ found, server, qualities? }, ctx)
// → [{ name: '1080p HLS 7Movies earth', url, ref, sizeBytes?, subtitles? }]
```

- Reuse `qualities` when passed; otherwise probe once internally (single code
  path, never two).
- Externally supplied refs may be stale → **re-validate every ref** before
  emitting. Output contains zero unvalidated links, always.
- **Label by what served, not what was asked**: if you requested Titan but the
  API served Star, the name says Star (`servedBy` from the response).
- Attach `subtitles` (parsed once per title) and `sizeBytes` for DDL.

### Stream names

```
{resolution} {size} {audio} {KIND} {provider}
1080p 2.4GB HIN HLS Nebula
720p ENG DDL Vidrift
4K 8.1GB HIN+ENG DASH Movy
HD DDL MovieNight madison
```

Built ONLY with `streamName()` — never hand-rolled. Missing parts are omitted,
never blank. Enforced by `STREAM_NAME_RE` in the contract test. Audio codes:
`ENG HIN TAM TEL MAL KAN JPN KOR` (+`MULTI`), via `normAudio()`.

---

## 6. Errors — the taxonomy

`TIMEOUT | BLOCKED | NOT_FOUND | PARSE | NEEDS_TMDB_KEY | NO_CANDIDATES |
ALL_DEAD | UNKNOWN`, each with `retryable`. Guidance:

- Site says no → `NOT_FOUND` (cached, not retried).
- WAF/rate-limit/timeout → `BLOCKED`/`TIMEOUT`, `retryable: true`.
- Shape changed → `PARSE` (this is the "update the field mapping" signal).
- Nothing playable → `NO_CANDIDATES` (keeps failover alive).

---

## 7. Testing — systematic, not blind

**A. Static gate** — `npx tsx src/cli.ts validate <site>`
Checks the file exports all 4 functions, id matches the registry key,
`supports` declared, fixture is a real `tt…`.

**B. Chain drill** — one primitive at a time, live:

```
chitra search  cinejoy --tmdb 155
chitra load    cinejoy --tmdb 155
chitra qs      cinejoy --tmdb 155 --server nebula     # resolution+size table
chitra streams cinejoy --tmdb 155 --server nebula     # validated links + kinds
chitra streams cinejoy --tmdb 155 --trace             # every HTTP call, timing
chitra diff    cinejoy [--record]                     # server list vs fixture
chitra doctor                                         # fleet view + browser status
```

**C. Contract test** — `npx vitest run test/providers.contract.test.ts`
Per provider: search finds fixture → load lists ≥1 server → `getStreams`
fires links → **every link re-validated independently** (`.m3u8` must fetch as
`#EXTM3U`, `.mpd` as `<MPD`, files as 200/206 non-HTML) → every name matches
the format regex. **PASS = ≥1 valid streamable link. Nothing else counts.**

**D. Fixture drift** — `chitra diff --record` writes
`test/fixtures/<site>.servers.json`; CI fails when the live list changes shape.

### Current verified state

| Provider   | search | load        | streams                    | Notes                                                                       |
| ---------- | ------ | ----------- | -------------------------- | --------------------------------------------------------------------------- |
| movienight | ✓      | ✓ 6 servers | ✓ `1080p/720p DDL … salem` | movies keyless; TV returns `Unauthorized` (login-gated, explicit `BLOCKED`) |
| 7movies    | ✓      | ✓           | ✓ `HD HLS 7Movies earth`   | availability-driven API; label = actual server                              |
| cinejoy    | ✓      | ✓ 4 servers | browser path (~60s)        | `/info` is metadata-only; player drives resolve                             |

A red test is information, not failure: it names the function, the error,
and the exact failing request. Transient upstream flakiness (502s, timeouts)
is expected — the suite reports it instead of hiding it.

---

## 8. Adding a provider, step by step

1. **Recon first**: `curl` the homepage, find the title URL shape, the server
   list endpoint (or player), the resolve call. Write down the 4 answers
   before writing code.
2. **Copy** `src/providers/_template.ts` → `src/providers/<site>.ts`.
3. **Fill `supports` + `fixture`** (a title you verified exists there).
4. **Implement search → load** (both cheap, both cached). Verify with
   `chitra search` + `chitra load`.
5. **Implement getVideoSizeResolution** (probe + validate). Verify with
   `chitra qs` — you should see a resolution/size table.
6. **Implement getStreams** (validate + name). Verify with `chitra streams`.
7. **Register**: one line in `src/registry.ts` (`ALL` + `ENABLED`).
8. **Run** `chitra validate`, `chitra diff --record`, then the contract test.
9. **Ship**: the server picks it up on restart (no hot-reload — restart always).

## 9. Scraping rules

- **HTTP fast-path first, browser only when the player is JS-rendered.**
  The browser lives in `src/scrape.ts` (shared pool, lazy-loaded so the
  server boots fast); providers call `scrapePlayer()` inside the same
  4 functions — the contract never changes.
- **DOM clicks, never coordinate clicks** (control bars auto-hide at opacity 0).
- **Scan every frame**, including embed iframes — server lists live in
  switcher buttons (`Switch to Titan`) as often as in JSON.
- **Resolve relative URLs** against the embed origin; absolutize everything.
- **Range your reads** (manifests, probes); abort segments (`.ts`/`.m4s`).
- **Name by what served**, not what was requested.
