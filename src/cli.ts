#!/usr/bin/env tsx
/**
 * cli.ts — chitra. The provider test-driver.
 *
 *   chitra search  cinejoy --tmdb 155
 *   chitra load    cinejoy --tmdb 155
 *   chitra qs      cinejoy --tmdb 155 --server nebula
 *   chitra streams cinejoy --tmdb 155 [--server nebula] [--json]
 *   chitra diff    cinejoy [--record]     # live servers() vs test fixture
 *   chitra test    cinejoy                # run the contract test for one site
 *   chitra doctor                          # fleet view
 *
 * Every command shows: what ran, how long it took, what it returned.
 * --json prints a machine-readable report instead of the pretty UI.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ALL, ENABLED } from "./registry.js";
import type { SiteId } from "./registry.js";
import {
  breaker,
  ctx,
  hostOf,
  streamName,
  tmdbKeySource,
  trace,
  validateStream,
} from "./lib.js";
import { browserStatus, closeBrowser } from "./scrape.js";
import type { TraceEvent } from "./lib.js";
import type {
  FoundTitle,
  Provider,
  ServerEntry,
} from "./providers/_template.js";
import type { ProviderError, Result } from "./lib.js";

/* ── ui ─────────────────────────────────────────────────────────────────── */
const TTY = !!process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;
const JSON_MODE = process.argv.includes("--json");
const paint = (code: string) => (s: string) =>
  TTY && !JSON_MODE ? `\x1b[${code}m${s}\x1b[0m` : s;
const C = {
  green: paint("32"),
  red: paint("31"),
  yellow: paint("33"),
  cyan: paint("36"),
  magenta: paint("35"),
  gray: paint("90"),
  bold: paint("1"),
};
const fmtMs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

function spin(label: string) {
  const t0 = Date.now();
  if (!TTY || JSON_MODE) {
    if (!JSON_MODE) console.log(`… ${label}`);
    return {
      ok: (m = "") => {
        if (!JSON_MODE)
          console.log(
            `${C.green("✓")} ${label} ${C.gray(fmtMs(Date.now() - t0))} ${m}`,
          );
      },
      fail: (m = "") => {
        if (!JSON_MODE)
          console.log(
            `${C.red("✗")} ${label} ${C.gray(fmtMs(Date.now() - t0))} ${m}`,
          );
      },
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(
      `\r${C.cyan(frames[i++ % frames.length] ?? " ")} ${label} … ${C.gray(fmtMs(Date.now() - t0))}   `,
    );
  }, 80);
  const done = (mark: string, msg: string) => {
    clearInterval(timer);
    process.stdout.write(
      `\r${mark} ${label} ${C.gray(fmtMs(Date.now() - t0))} ${msg}\n`,
    );
  };
  return {
    ok: (m = "") => done(C.green("✓"), m),
    fail: (m = "") => done(C.red("✗"), m),
  };
}

function table(headers: string[], rows: string[][]): void {
  if (JSON_MODE) return;
  if (!rows.length) {
    console.log(`  ${C.gray("(empty)")}`);
    return;
  }
  const w = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[], dim = false) =>
    console.log(
      (dim ? C.gray : (s: string) => s)(
        `  ${cells.map((c, i) => (c ?? "").padEnd(w[i] ?? 0)).join("  ")}`,
      ),
    );
  line(headers, true);
  console.log(C.gray(`  ${w.map((n) => "─".repeat(n)).join("  ")}`));
  for (const r of rows) line(r);
}

function badge(kind: string, extra = ""): string {
  if (kind === "hls") return C.cyan(`[HLS${extra}]`);
  if (kind === "dash") return C.magenta(`[DASH${extra}]`);
  if (kind === "ddl") return C.green(`[DDL${extra}]`);
  return C.red(`[DEAD${extra ? " " + extra : ""}]`);
}

function showTrace(events?: TraceEvent[]): void {
  const evs = events ?? trace.events();
  if (!evs.length || JSON_MODE) return;
  console.log(`\n  ${C.bold("HTTP trace")} (${evs.length} requests)`);
  table(
    ["op", "status", "time", "size", "url"],
    evs
      .slice(-14)
      .map((e) => [
        e.op,
        e.status !== undefined
          ? e.status < 400
            ? C.green(String(e.status))
            : C.red(String(e.status))
          : C.red("ERR"),
        e.ms !== undefined ? fmtMs(e.ms) : "-",
        e.bytes !== undefined ? humanSize(e.bytes) : "-",
        e.url.length > 72 ? e.url.slice(0, 72) + "…" : e.url,
      ]),
  );
}

/* where-did-it-go-wrong block: function → error → the exact requests behind it */
function failContext(label: string, code: string, message: string): void {
  if (JSON_MODE) return;
  console.log(`\n  ${C.red("▼ " + label + " failed")}`);
  console.log(`  ${C.gray("error:")} ${C.bold(code)} ${message.slice(0, 160)}`);
  const evs = trace.events().slice(-3);
  if (evs.length) {
    console.log(`  ${C.gray("last requests:")}`);
    for (const e of evs) {
      const st = e.status !== undefined ? String(e.status) : (e.error ?? "?");
      console.log(
        `  ${C.gray("├─")} ${e.op} ${st} ${e.ms !== undefined ? fmtMs(e.ms) : ""}  ${e.url.slice(0, 90)}`,
      );
    }
  }
  console.log(`  ${C.gray("hint:")} ${hintFor(code)}`);
}

function hintFor(code: string): string {
  if (code === "NEEDS_TMDB_KEY")
    return "export TMDB_API_KEY=… (tmdb-only site cannot resolve an imdb key)";
  if (code === "NO_CANDIDATES")
    return "page has no static media — player is JS-rendered, needs a browser bake or the watch API";
  if (code === "BLOCKED" || code === "TIMEOUT")
    return "WAF/rate-limit: lower concurrency, retry later, or route via the site mirror";
  if (code === "NOT_FOUND")
    return "title missing on this site (or the site changed its URL scheme)";
  if (code === "PARSE")
    return "site changed its JSON shape — update the provider's field mapping";
  return "see the trace above for the exact failing request";
}

function hr(): void {
  if (!JSON_MODE) console.log(C.gray("  ─".repeat(24)));
}

function die(m: string): never {
  console.error(
    JSON_MODE ? JSON.stringify({ ok: false, error: m }) : `${C.red("✗")} ${m}`,
  );
  process.exit(1);
  throw new Error("unreachable");
}

/* unwrap or exit — the positive check narrows where a never-call guard does not */
function unwrap<T>(r: Result<T, ProviderError>, label: string): T {
  if (r.ok) return r.value;
  die(`${label}: ${r.error.code} ${r.error.message}`);
}

/* ── args ───────────────────────────────────────────────────────────────── */
const args = process.argv
  .slice(2)
  .filter((a) => a !== "--json" && a !== "--record");
const cmd = args[0];
const site = args[1] as SiteId | undefined;
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const RECORD = process.argv.includes("--record");
const TRACE = process.argv.includes("--trace");
const PICK = process.argv.includes("--pick");
if (TRACE) trace.on();
if (
  !cmd ||
  ![
    "search",
    "load",
    "qs",
    "streams",
    "diff",
    "doctor",
    "test",
    "validate",
  ].includes(cmd)
) {
  die(
    'usage: chitra <search|load|qs|streams|diff|doctor|test|validate> <site> [--tmdb N|--imdb tt…|--name "Title"] [--year N] [--server id] [--trace] [--pick] [--json]',
  );
}
if (cmd !== "doctor" && (!site || !ALL[site]))
  die(`unknown site '${site}'. known: ${Object.keys(ALL).join(", ")}`);

const prov = site ? ALL[site] : undefined;
const tmdbRaw = flag("--tmdb");
const tmdb = tmdbRaw ? Number(tmdbRaw) : undefined;
const imdb = flag("--imdb");
const name = flag("--name");
const yearRaw = flag("--year");
const year = yearRaw ? Number(yearRaw) : undefined;
const type = (flag("--type") ?? "movie") as "movie" | "series";
const seasonRaw = flag("--season");
const episodeRaw = flag("--episode");
const season = seasonRaw ? Number(seasonRaw) : undefined;
const episode = episodeRaw ? Number(episodeRaw) : undefined;
const report: Record<string, unknown> = { cmd, site, type };

async function step<T>(
  label: string,
  fn: () => Promise<Result<T, ProviderError>>,
): Promise<T | null> {
  const s = spin(label);
  const r = await fn();
  if (!r.ok) {
    s.fail(`${r.error.code}`);
    failContext(label, r.error.code, r.error.message);
    report[label] = { ok: false, code: r.error.code, message: r.error.message };
    return null;
  }
  s.ok();
  return r.value;
}

function keyLabel(): string {
  if (imdb) return `imdb:${imdb}`;
  if (tmdb) return `tmdb:${tmdb}`;
  if (name) return `name:${name}`;
  return "(no key!)";
}
async function needFound(): Promise<FoundTitle> {
  if (!prov) die("no provider");
  const items = await step(`SEARCH ${type} ${keyLabel()}`, () =>
    prov.search({ type, imdb, tmdb, name, year }, ctx(15000)),
  );
  if (!items?.length) {
    if (!JSON_MODE) console.log(`  ${C.gray("(no match)")}`);
    die("no match");
  }
  const f = items[0] as FoundTitle;
  report.found = f;
  if (!JSON_MODE)
    console.log(
      `  └─ ${C.bold(f.title)} ${C.gray(`(siteId=${f.siteTitleId}${f.year ? ` · ${f.year}` : ""})`)}`,
    );
  return f;
}

async function main(): Promise<void> {
  const t0 = Date.now();

  if (cmd === "doctor") {
    const rows = ENABLED.map((id) => {
      const p = ALL[id];
      return [
        id,
        p.supports.imdb ? "imdb" : "-",
        p.supports.tmdb ? "tmdb" : "-",
        p.fixture.imdb,
        breaker.state(id),
      ];
    });
    if (JSON_MODE) {
      console.log(
        JSON.stringify(
          {
            providers: rows.map((r) => ({
              id: r[0],
              imdb: r[1],
              tmdb: r[2],
              fixture: r[3],
              breaker: r[4],
            })),
          },
          null,
          1,
        ),
      );
      return;
    }
    console.log(
      `providers: ${C.bold(String(Object.keys(ALL).length))} total, ${C.bold(String(ENABLED.length))} enabled`,
    );
    console.log(`TMDB key: ${C.green(tmdbKeySource() + " (never asked)")}\n`);
    table(["site", "imdb", "tmdb", "fixture", "breaker"], rows);
    return;
  }
  if (!prov || !site) die("no provider");

  if (cmd === "validate") {
    if (!prov || !site) die("no provider");
    const checks: [string, boolean, string][] = [];
    const fns = [
      "search",
      "load",
      "getVideoSizeResolution",
      "getStreams",
    ] as const;
    for (const fn of fns)
      checks.push([
        `exports ${fn}()`,
        typeof (prov as unknown as Record<string, unknown>)[fn] === "function",
        "",
      ]);
    checks.push([
      "id matches registry key",
      prov.id === site,
      `${prov.id} vs ${site}`,
    ]);
    checks.push([
      "supports.imdb/tmdb declared",
      typeof prov.supports.imdb === "boolean" &&
        typeof prov.supports.tmdb === "boolean",
      "",
    ]);
    checks.push([
      "fixture has imdb",
      /^tt\d+$/.test(prov.fixture.imdb),
      prov.fixture.imdb,
    ]);
    const bad = checks.filter(([, b]) => !b);
    if (!JSON_MODE) {
      for (const [name, b, extra] of checks)
        console.log(
          `  ${b ? C.green("✓") : C.red("✗")} ${name}${extra && !b ? ` (${extra})` : ""}`,
        );
    } else
      console.log(
        JSON.stringify(
          { ok: !bad.length, checks: checks.map(([n, b]) => ({ n, b })) },
          null,
          1,
        ),
      );
    if (bad.length) process.exitCode = 1;
    return;
  }

  if (cmd === "test") {
    const s = spin(`contract test ${site}`);
    const r = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "test/providers.contract.test.ts",
        "-t",
        `provider:${site}`,
        "--reporter=basic",
      ],
      {
        encoding: "utf8",
        timeout: 180000,
      },
    );
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const m = out.match(/Tests\s+(\d+) passed.*?(\d+) (failed|skipped)?/);
    if (r.status === 0) s.ok(m ? m[0] : "");
    else {
      s.fail(`exit ${r.status}`);
      if (!JSON_MODE)
        console.log(
          out
            .split("\n")
            .filter((l) => /✓|×|✗|FAIL|AssertionError|expected/i.test(l))
            .slice(0, 14)
            .join("\n"),
        );
    }
    if (JSON_MODE)
      console.log(JSON.stringify({ ok: r.status === 0, exit: r.status }));
    return;
  }

  if (cmd === "search") {
    const items = await step(`SEARCH ${type} ${keyLabel()}`, () =>
      prov.search({ type, imdb, tmdb, name, year }, ctx(15000)),
    );
    if (!items) return;
    report.results = items;
    table(
      ["title", "siteId", "year", "imdb", "tmdb"],
      items.map((f) => [
        f.title,
        f.siteTitleId,
        String(f.year ?? "-"),
        f.imdb ?? "-",
        String(f.tmdb ?? "-"),
      ]),
    );
    if (JSON_MODE) console.log(JSON.stringify(report, null, 1));
    return;
  }

  const f = await needFound();
  const servers = await step(`LOAD → servers`, () => prov.load(f, ctx(15000)));
  if (!servers) return;
  report.servers = servers;
  table(
    ["id", "status", "quality", "prio"],
    servers.map((s) => [
      s.status === "ok"
        ? C.green(s.id)
        : s.status === "testing"
          ? C.yellow(s.id)
          : C.red(s.id),
      s.status,
      s.quality ?? "-",
      String(s.priority),
    ]),
  );

  if (cmd === "load") {
    if (JSON_MODE) console.log(JSON.stringify(report, null, 1));
    return;
  }

  if (cmd === "diff") {
    const fx = `test/fixtures/${site}.servers.json`;
    const live = servers.map((s: ServerEntry) => s.name).sort();
    report.live = live;
    if (RECORD || !fs.existsSync(fx)) {
      fs.mkdirSync("test/fixtures", { recursive: true });
      fs.writeFileSync(fx, JSON.stringify(live, null, 1) + "\n");
      if (!JSON_MODE) console.log(`\nrecorded ${fx}`);
      report.recorded = fx;
    } else {
      const want = JSON.parse(fs.readFileSync(fx, "utf8")) as string[];
      const gone = want.filter((x) => !live.includes(x));
      const added = live.filter((x) => !want.includes(x));
      report.want = want;
      report.gone = gone;
      report.added = added;
      if (!JSON_MODE) {
        if (!gone.length && !added.length)
          console.log(
            `\n${C.green("OK")} — matches fixture (${live.length} servers)`,
          );
        else {
          for (const g of gone) console.log(`  ${C.red("- " + g)}`);
          for (const a of added) console.log(`  ${C.green("+ " + a)}`);
          process.exitCode = 2;
        }
      } else console.log(JSON.stringify(report, null, 1));
    }
    return;
  }

  // qs | streams
  const srvName = flag("--server");
  const targets = (
    srvName
      ? servers.filter(
          (s) =>
            s.id === srvName || s.name.toLowerCase() === srvName.toLowerCase(),
        )
      : servers.filter((s) => s.status === "ok")
  ).slice(0, 3);
  if (!targets.length) die("no matching server (run `chitra load` to list)");
  report.targets = targets.map((s) => s.name);

  let valid = 0,
    dead = 0;
  const kinds: Record<string, number> = {};
  for (const srv of targets) {
    const q0 = { found: f, server: srv, season, episode };
    if (cmd === "qs") {
      const quals = await step(`QS ${srv.name} → resolution+size`, () =>
        prov.getVideoSizeResolution(q0, ctx(20000)),
      );
      if (!quals) continue;
      report[`qs:${srv.id}`] = quals;
      table(
        ["resolution", "size", "audio", "ref host"],
        quals.map((q) => [
          C.bold(q.resolution),
          q.sizeBytes != null ? humanSize(q.sizeBytes) : C.gray("—"),
          q.audio.length ? q.audio.join("+") : C.gray("—"),
          C.gray(hostOf(q.ref)),
        ]),
      );
    } else {
      const s = spin(`STREAMS ${srv.name} → resolving`);
      const g = await prov.getStreams(q0, ctx(60000));
      if (!g.ok) {
        s.fail(`${g.error.code}`);
        failContext(`STREAMS ${srv.name}`, g.error.code, g.error.message);
        continue;
      }
      s.ok(`${g.value.length} candidate${g.value.length === 1 ? "" : "s"}`);
      report[`streams:${srv.id}`] = g.value;
      for (const link of g.value.slice(0, 8)) {
        const v = await validateStream(link.url, 8000);
        if (v.ok) {
          valid++;
          kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
          if (!JSON_MODE) {
            console.log(
              `  ${badge(v.kind, v.kind === "ddl" && v.sizeBytes ? " " + humanSize(v.sizeBytes) : "")} ${link.name}`,
            );
            console.log(`  ${C.gray("└─")} ${C.gray(link.url.slice(0, 110))}`);
          }
        } else {
          dead++;
          if (!JSON_MODE) {
            console.log(`  ${badge("dead", v.reason)} ${C.gray(link.name)}`);
            console.log(`  ${C.gray("└─")} ${C.gray(link.url.slice(0, 110))}`);
          }
        }
      }
    }
  }

  if (TRACE && (cmd === "qs" || cmd === "streams")) showTrace();
  if (cmd === "streams") {
    report.valid = valid;
    report.dead = dead;
    report.kinds = kinds;
    report.elapsedMs = Date.now() - t0;
    if (TRACE) report.trace = trace.events();
    if (JSON_MODE) {
      console.log(JSON.stringify(report, null, 1));
      return;
    }
    hr();
    const kindStr = Object.entries(kinds)
      .map(([k, n]) => `${k}×${n}`)
      .join(" ");
    console.log(
      valid > 0
        ? `  ${C.green("✓")} ${C.bold(String(valid))} valid ${kindStr ? `(${kindStr}) ` : ""}· ${dead} dead · ${fmtMs(Date.now() - t0)} total`
        : `  ${C.red("✗")} 0 valid · ${dead} dead · ${fmtMs(Date.now() - t0)} total`,
    );
  } else if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 1));
  }
}
function humanSize(b: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0,
    v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number(v.toFixed(v >= 100 ? 0 : 1))}${u[i]}`;
}

main().catch((e) =>
  die(
    `fatal: ${String(e && (e as Error).message ? (e as Error).message : e).slice(0, 200)}`,
  ),
);
