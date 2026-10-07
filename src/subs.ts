/**
 * subs.ts — external subtitle addons (OpenSubtitles v3 & co.), merged with the
 * streams' own internal subtitles without collision.
 *
 * Rules: internal subs first (timed to the release), externals appended,
 * deduped by URL, capped. A dead subtitle addon never breaks video results —
 * it is skipped silently behind its own breaker.
 */
import { breaker, cached, cacheKey, getJSON, mapLimit, safe } from "./lib.js";
import { SUBTITLE_ADDONS } from "./web.js";

export interface ExtSub {
  url: string;
  lang: string;
  origin: string;
}

export async function fetchExternalSubs(
  type: "movie" | "series",
  id: string,
  season?: number,
  episode?: number,
): Promise<ExtSub[]> {
  const addons = SUBTITLE_ADDONS.filter((a) => a.url);
  if (!addons.length) return [];
  const sid =
    season !== undefined && episode !== undefined
      ? `${id}:${season}:${episode}`
      : id;
  const key = cacheKey(
    "extsubs",
    type,
    sid,
    addons.map((a) => a.url).join(",").length,
  );
  return cached(key, 24 * 3600_000, async () => {
    const parts = await mapLimit(addons.slice(0, 5), 3, async (a) => {
      const base = a.url.replace(/\/manifest\.json\/?$/, "").replace(/\/$/, "");
      const r = await breaker.run(`subs:${base}`, () =>
        safe(
          async () => {
            const res = await getJSON<{
              subtitles?: { url?: string; lang?: string }[];
            }>(`${base}/subtitles/${type}/${sid}.json`, { timeout: 8000 });
            if (!res.ok) throw new Error(res.error.message);
            return res.value.subtitles ?? [];
          },
          { deadline: 9000, label: `subs ${base}` },
        ),
      );
      if (!r.ok) return [];
      const list: ExtSub[] = [];
      for (const s of r.value.slice(0, 30)) {
        if (typeof s.url === "string" && s.url.startsWith("http")) {
          list.push({
            url: s.url,
            lang: String(s.lang ?? "und").slice(0, 8),
            origin: base,
          });
        }
      }
      return list;
    });
    const out = parts.flat();
    return [...new Map(out.map((o) => [o.url, o])).values()].slice(0, 40);
  });
}
