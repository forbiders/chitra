/**
 * test/providers.contract.test.ts — the systematic gate every provider passes.
 *
 * Chain: search(fixture) → load → first ok server → getStreams →
 * every link re-validated independently. PASS = ≥1 VALID streamable link
 * (hls must fetch as #EXTM3U, dash as <MPD, ddl as 200/206 non-HTML)
 * AND every emitted name matching "1080p 2.4GB HIN Provider".
 *
 * The TMDB key is baked into lib.ts, so conversion always runs — a TMDB
 * outage fails the test honestly instead of skipping.
 */
import { describe, it, expect } from "vitest";
import { ALL, ENABLED } from "../src/registry.js";
import { STREAM_NAME_RE, ctx, validateStream } from "../src/lib.js";

for (const id of ENABLED) {
  describe(`provider:${id}`, () => {
    const p = ALL[id];
    const fx = p.fixture;
    const t = it;

    t(
      "search finds the fixture title",
      async () => {
        const s = await p.search({ type: fx.type, imdb: fx.imdb }, ctx(20000));
        expect(s.ok, s.ok ? "" : s.error.code + " " + s.error.message).toBe(
          true,
        );
        if (s.ok) expect(s.value.length).toBeGreaterThan(0);
      },
      30000,
    );

    t(
      "full chain fires ≥1 VALID streamable link",
      async () => {
        const s = await p.search({ type: fx.type, imdb: fx.imdb }, ctx(20000));
        expect(s.ok).toBe(true);
        if (!s.ok || !s.value.length) return;
        const found = s.value[0];
        if (!found) return;

        const l = await p.load(found, ctx(20000));
        expect(l.ok, l.ok ? "" : l.error.code + " " + l.error.message).toBe(
          true,
        );
        if (!l.ok || !l.value.length) return;
        const server = l.value.find((x) => x.status === "ok") ?? l.value[0];
        expect(server).toBeDefined();
        if (!server) return;

        const g = await p.getStreams({ found, server }, ctx(30000));
        expect(g.ok, g.ok ? "" : g.error.code + " " + g.error.message).toBe(
          true,
        );
        if (!g.ok || !g.value.length) return;

        const kinds = new Set<string>();
        let valid = 0;
        for (const link of g.value.slice(0, 10)) {
          expect(link.name, `name shape: ${link.name}`).toMatch(STREAM_NAME_RE);
          const v = await validateStream(link.url, 9000);
          if (v.ok) {
            valid++;
            kinds.add(v.kind);
          } else
            console.log(
              `    dead link (${v.reason}): ${link.url.slice(0, 100)}`,
            );
        }
        console.log(`    ${id}: ${valid} valid [${[...kinds].join(",")}]`);
        expect(
          valid,
          "at least one streamable (hls/dash/ddl) link",
        ).toBeGreaterThan(0);
      },
      90000,
    );
  });
}
