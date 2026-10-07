/**
 * server.ts — the whole addon: manifest + 2 routes.
 * stream-only addon: no catalog, no meta. Stremio supplies titles (Cinemeta),
 * Chitra supplies links.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ALL, ENABLED } from "./registry.js";
import {
  decodeConfig,
  effectiveSettings,
  lastHealth,
  rankStreams,
  recordHealth,
  startProber,
} from "./web.js";
import { fetchExternalSubs } from "./subs.js";
import type { SiteId } from "./registry.js";
import {
  breaker,
  ctx,
  hostOf,
  ok,
  parseStremioId,
  raceUntil,
  safe,
  validateStream,
} from "./lib.js";
import type { FoundTitle, StreamLink } from "./providers/_template.js";
import { serveStatic } from "@hono/node-server/serve-static";

const app = new Hono();
app.use("*", cors());

const MANIFEST = {
  id: "org.chitra.streams",
  version: "0.1.0",
  name: "Chitra",
  description:
    "Movies and series from everywhere, in one list. Pick a title, get working links with quality, size and audio labels.",
  logo: "https://raw.githubusercontent.com/decodede/cs-repo/main/icons/screen.png",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb"],
  /* Chitra serves only the `stream` resource, so there is nothing to list here.
   * The field still has to be present: stremio-addon-linter asserts it
   * unconditionally (manifest.catalogs must be an array) and beamup's
   * beamup-lint pre-receive hook refuses to deploy an addon that fails it. */
  catalogs: [],
};

app.get("/manifest.json", (c) => c.json(MANIFEST));
app.get("/:cfg/manifest.json", (c) => {
  let seg: string | undefined;
  try {
    seg = c.req.param("cfg");
  } catch {
    seg = undefined;
  }
  if (!seg || !decodeConfig(seg)) return c.json({ error: "bad config" }, 400);
  return c.json(MANIFEST);
});
app.get("/", (c) => c.redirect("/dashboard/"));
app.get("/dashboard", (c) => c.redirect("/dashboard/"));
app.use(
  "/dashboard/*",
  serveStatic({
    root: "./public",
    rewriteRequestPath: (p) => {
      const q = p.replace(/^\/dashboard/, "") || "/";
      return q === "/" ? "/index.html" : q;
    },
  }),
);

/* /stream — the only expensive path. Budgets are fixed operational constants. */
async function handleStream(c: never): Promise<never> {
  const cc = c as unknown as {
    req: { param: (n: string) => string };
    json: (o: unknown) => never;
  };
  const type = cc.req.param("type");
  const vid = cc.req.param("vid");
  let cfgSeg: string | undefined;
  try {
    cfgSeg = cc.req.param("cfg");
  } catch {
    cfgSeg = undefined;
  }
  const eff = effectiveSettings(cfgSeg);
  const id = decodeURIComponent(vid.replace(/\.json$/, ""));
  if (type !== "movie" && type !== "series") return cc.json({ streams: [] });
  const p = parseStremioId(id);
  const q = {
    type: type as "movie" | "series",
    imdb: p.imdb,
    tmdb: p.tmdb,
    season: p.season,
    episode: p.episode,
  };
  const BUDGET = eff.timeoutMs;
  const MAX_PER_PROVIDER = 6;
  const tasks = eff.providers.slice(0, 10).map((site: SiteId) => async () => {
    const prov = ALL[site];
    return breaker.run(site, () =>
      safe(
        async () => {
          const se = await prov.search(q, ctx(Math.round(BUDGET * 0.3)));
          if (!se.ok) throw new Error(se.error.message);
          const found = se.value[0];
          if (!found) throw new Error("no match");
          const lo = await prov.load(found, ctx(Math.round(BUDGET * 0.2)));
          if (!lo.ok) throw new Error(lo.error.message);
          if (!lo.value.length) throw new Error("no servers");
          const links: StreamLink[] = [];
          for (const srv of lo.value
            .filter((x) => x.status !== "down")
            .slice(0, 2)) {
            const g = await prov.getStreams(
              { found, server: srv, season: q.season, episode: q.episode },
              ctx(Math.round(BUDGET * 0.45)),
            );
            if (g.ok) links.push(...g.value.slice(0, MAX_PER_PROVIDER));
            if (links.length >= 6) break;
          }
          if (!links.length) throw new Error("no streams");
          return links;
        },
        { deadline: BUDGET, label: `stream ${site}` },
      ),
    );
  });
  const r = await raceUntil(tasks, {
    timeout: BUDGET + 1000,
    concurrency: 8,
    enough: 2,
  });
  if (!r.ok) return cc.json({ streams: [] });
  const ranked = rankStreams(r.value.flat()).slice(0, 24);
  /* two servers often resolve to the same upstream behind signed URLs that
     differ per request — dedupe by name+host so Stremio never shows twins. */
  const seen = new Set<string>();
  const keyOf = (l: { name: string; url: string }): string => {
    let host = "?";
    try {
      host = new URL(l.url).host;
    } catch {
      /* keep ? */
    }
    return `${l.name} @ ${host}`;
  };
  const unique = ranked.filter((l) =>
    seen.has(keyOf(l)) ? false : (seen.add(keyOf(l)), true),
  );
  const ext = eff.extSubsOn
    ? await fetchExternalSubs(
        type as "movie" | "series",
        id,
        q.season,
        q.episode,
      ).catch(() => [])
    : [];
  return cc.json({
    streams: unique.map((l) => {
      const internal = eff.subsOn ? (l.subtitles ?? []) : [];
      const have = new Set(internal.map((x) => x.url));
      const merged = [
        ...internal,
        ...ext.filter((e) => !have.has(e.url)),
      ].slice(0, 20);
      const hints: Record<string, unknown> = {};
      if (typeof l.sizeBytes === "number") hints.videoSize = l.sizeBytes;
      if (l.headers && Object.keys(l.headers).length)
        hints.proxyHeaders = { request: l.headers };
      return {
        name: l.name,
        description: `${l.name}\n${hostOf(l.url)}`,
        url: l.url,
        ...(merged.length
          ? { subtitles: merged.map((x) => ({ url: x.url, lang: x.lang })) }
          : {}),
        ...(Object.keys(hints).length ? { behaviorHints: hints } : {}),
      };
    }),
  });
}
app.get("/stream/:type/:vid", (c) => handleStream(c as never));
app.get("/:cfg/stream/:type/:vid", (c) => handleStream(c as never));

/* ── dashboard API: read-only provider list + test runner. No settings. ── */
app.get("/api/providers", (c) => {
  return c.json(
    Object.keys(ALL).map((id) => {
      const p = ALL[id as keyof typeof ALL];
      const h = lastHealth(id as SiteId);
      const prov = ALL[id as SiteId];
      return {
        id,
        blurb: prov.blurb,
        supports: p.supports,
        fixture: p.fixture,
        breaker: breaker.state(id),
        alive:
          h.lastResult === null
            ? null
            : !/fail|error|dead|unauthorized|forbidden|not-found|timeout/i.test(
                h.lastResult,
              ),
        lastCheck: h.lastCheck,
      };
    }),
  );
});
app.post("/api/test/:id", async (c) => {
  const id = c.req.param("id") as keyof typeof ALL;
  if (!(id in ALL)) return c.json({ error: "unknown provider" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: "movie" | "series";
    imdb?: string;
    tmdb?: number;
  };
  const prov = ALL[id];
  const t0 = Date.now();
  const rep: Record<string, unknown> = { site: id, steps: [] as unknown[] };
  const push = (step: string, ok: boolean, detail: unknown) => {
    (rep.steps as unknown[]).push({ step, ok, detail, ms: Date.now() - t0 });
  };
  const q = { type: body.type ?? "movie", imdb: body.imdb, tmdb: body.tmdb };
  const se = await prov.search(q as never, ctx(20000));
  push("search", se.ok, se.ok ? se.value.map((f) => f.siteTitleId) : se.error);
  if (!se.ok || !se.value.length) {
    recordHealth(id as never, Date.now() - t0, "search-fail");
    return c.json(rep);
  }
  const found = se.value[0] as FoundTitle;
  const lo = await prov.load(found, ctx(15000));
  push("load", lo.ok, lo.ok ? lo.value.map((x) => x.name) : lo.error);
  if (!lo.ok) {
    recordHealth(id as never, Date.now() - t0, "load-fail");
    return c.json(rep);
  }
  const links: StreamLink[] = [];
  for (const srv of lo.value.filter((x) => x.status !== "down").slice(0, 2)) {
    const g = await prov.getStreams({ found, server: srv }, ctx(30000));
    push(
      `streams:${srv.name}`,
      g.ok,
      g.ok ? g.value.map((l) => l.name) : g.error,
    );
    if (g.ok) {
      for (const l of g.value.slice(0, 6)) {
        const v = await validateStream(l.url, 8000);
        if (v.ok) links.push(l);
      }
    }
  }
  rep.links = links;
  recordHealth(
    id as never,
    Date.now() - t0,
    links.length ? `${links.length} valid` : "no-valid",
  );
  return c.json(rep);
});

const port = Number(process.env.PORT ?? 7000);
startProber();
export default { port, fetch: app.fetch };
const RUN_DIRECTLY =
  (process.argv[1] ?? "").endsWith("server.ts") ||
  (process.argv[1] ?? "").endsWith("server.js");
if (RUN_DIRECTLY) {
  const { serve } = await import("@hono/node-server").catch(() => ({
    serve: null as never,
  }));
  if (serve) serve({ fetch: app.fetch, port });
  else
    console.log(
      `manifest ready — serve dist/ or run with @hono/node-server on :${port}`,
    );
}
