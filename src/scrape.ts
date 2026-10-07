/**
 * scrape.ts — the shared browser engine. One lazy Chromium, isolated context
 * per call. Providers use it inside getStreams()/getVideoSizeResolution()
 * ONLY when no HTTP API yields the answer (JS-rendered players).
 *
 * Nothing here is provider-specific: site knowledge (URLs, selectors) lives
 * in providers/*.ts and is passed in via ScrapeOpts.
 */
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { trace } from "./lib.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const AD =
  /(doubleclick|googlesyndication|googletagservices|google-analytics|adsbygoogle|adservice|adnxs|popads|propellerads|exoclick|juicyads|tabundera|hilltopads|adsterra|trafficjunky|mgid|adsk|amazon-adsystem|adsmoloco|popcash|smartadserver|teads|outbrain|revcontent|zedo|bidvertiser|adcash|clickadu|monetizepleasure|statcounter|histats|hotjar|clarity|cloudflareinsights|sentry|gtag|googletagmanager)/i;
const MEDIA = /\.(m3u8|mpd|mp4|webm|mkv)(\?|$)/i;
const SEGMENT = /\.(ts|m4s)(\?|$)/i;

export interface ScrapeOpts {
  url: string;
  playSelectors: string[];
  panelSelectors?: string[];
  serverName?: string;
  timeout?: number;
  onEvent?: (msg: string) => void;
}
export interface ScrapeResult {
  servers: string[];
  media: string[];
  frames: string[];
  landedUrl: string;
}

let browser: Browser | null = null;
let lastUsed = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function armIdleClose(): void {
  lastUsed = Date.now();
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (browser && Date.now() - lastUsed > 5 * 60_000) {
      void closeBrowser();
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    }
  }, 60_000);
  if (typeof (idleTimer as unknown as { unref?: () => void }).unref === "function") {
    (idleTimer as unknown as { unref: () => void }).unref();
  }
}
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}
export async function closeBrowser(): Promise<void> {
  try {
    await browser?.close();
  } catch {
    /* already dead */
  }
  browser = null;
}
export function browserStatus(): { installed: boolean; path?: string } {
  try {
    const p = chromium.executablePath();
    return { installed: true, path: p };
  } catch {
    return { installed: false };
  }
}

/* Playwright pseudo-selectors (:has-text) are invalid in evaluate() — resolve
   through the locator engine, then dispatch a real DOM .click() so it lands
   even when the player auto-hid its control bar (opacity:0). */
async function firstVisible(
  page: Page,
  sels: string[],
): Promise<string | null> {
  const counts = await Promise.all(
    sels.map((s) =>
      page
        .locator(s)
        .count()
        .catch(() => 0),
    ),
  );
  for (let i = 0; i < sels.length; i++) {
    if ((counts[i] ?? 0) <= 0) continue;
    const found = sels[i];
    if (found) return found;
  }
  return null;
}
async function domClick(page: Page, sel: string): Promise<string | null> {
  try {
    const loc = page.locator(sel).first();
    if (!(await loc.isVisible({ timeout: 900 }))) return null;
    const h = await loc.elementHandle({ timeout: 1000 }).catch(() => null);
    if (!h) return null;
    const label = await h
      .evaluate((el) => {
        const cs = getComputedStyle(el as unknown as Element);
        const r = (el as unknown as Element).getBoundingClientRect();
        if (
          cs.display === "none" ||
          cs.visibility === "hidden" ||
          r.width < 10 ||
          r.height < 5
        )
          return null;
        (el as unknown as { click: () => void }).click();
        const t = el as unknown as { innerText?: string; getAttribute?: (n: string) => string | null };
        return ((t.innerText || (t.getAttribute ? t.getAttribute("aria-label") : null) || "") as string)
          .trim()
          .slice(0, 40);
      })
      .catch(() => null);
    await h.dispose().catch(() => {});
    return label === null ? null : label;
  } catch {
    return null;
  }
}
async function dismiss(page: Page): Promise<void> {
  for (const s of [
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    '[aria-label="Close"]',
    'button:has-text("No thanks")',
    "#accept",
  ]) {
    try {
      const l = page.locator(s).first();
      if (await l.isVisible({ timeout: 250 })) {
        await l.click({ timeout: 700, force: true });
        await page.waitForTimeout(200);
        return;
      }
    } catch {
      /* next */
    }
  }
}
async function waitForContent(page: Page, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = await page
      .evaluate(
        () =>
          Math.min(document.querySelectorAll("a[href],button").length, 400) +
          Math.min((document.body?.innerText || "").length, 300),
      )
      .catch(() => 0);
    if (n > 25) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

/* switcher buttons inside any frame: "Switch to Titan" / "Earth — Testing" */
async function scanSwitchers(page: Page): Promise<string[]> {
  const frames = [
    page.mainFrame(),
    ...page
      .frames()
      .filter((f) => f !== page.mainFrame() && /^https?:/.test(f.url())),
  ];
  const res = await Promise.all(
    frames.map((fr) =>
      fr
        .evaluate(() => {
          const out: string[] = [];
          const RX = [
            /^(?:switch to|use|select|play on|open)\s+([A-Za-z][\w ]{1,20})$/i,
            /^([A-Z][A-Za-z]{2,14})\s*[—–-]\s*(Testing|Available|Unavailable|Selected|Active|HD|4K|Offline)/,
          ];
          for (const b0 of document.querySelectorAll(
            'button,[role="button"],[role="tab"],[role="option"],li',
          )) {
            const b = b0 as HTMLElement;
            for (const raw of [
              b.getAttribute("aria-label"),
              b.getAttribute("title"),
              (b.innerText || "").trim(),
            ]) {
              const label = (raw || "").trim();
              if (!label || label.length > 60) continue;
              let m: RegExpExecArray | null = null;
              for (const rx of RX) {
                m = rx.exec(label);
                if (m) break;
              }
              if (!m?.[1]) continue;
              const name = m[1].replace(/[!.]+$/, "").trim();
              if (
                !name ||
                /exit|cancel|close|back|menu/i.test(name) ||
                out.includes(name)
              )
                continue;
              out.push(name);
              break;
            }
          }
          return out;
        })
        .catch(() => [] as string[]),
    ),
  );
  return [...new Set(res.flat())];
}

async function clickServer(page: Page, name: string): Promise<boolean> {
  const want = name.toLowerCase();
  for (const fr of [
    page.mainFrame(),
    ...page.frames().filter((f) => /^https?:/.test(f.url())),
  ]) {
    const hit = await fr
      .evaluate((w) => {
        const els = [
          ...document.querySelectorAll(
            'button,[role="button"],[role="tab"],li',
          ),
        ].map((e) => e as HTMLElement);
        const el = els.find((e) => {
          const t = (
            (e.innerText || "") +
            " " +
            (e.getAttribute("aria-label") || "")
          ).toLowerCase();
          return t.includes(w);
        });
        if (!el) return false;
        (el as HTMLElement).click();
        return true;
      }, want)
      .catch(() => false);
    if (hit) return true;
  }
  return false;
}

export async function scrapePlayer(o: ScrapeOpts): Promise<ScrapeResult> {
  const timeout = o.timeout ?? 45000;
  const t0 = Date.now();
  const left = () => timeout - (Date.now() - t0);
  const say = (m: string) => {
    o.onEvent?.(m);
    trace.push({ op: "browser", url: `${m} ← ${o.url.slice(0, 80)}` });
  };
  const media = new Map<string, number>();

  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.route("**/*", (rt) => {
    const u = rt.request().url();
    const ty = rt.request().resourceType();
    if (ty !== "document" && AD.test(u)) return rt.abort();
    if (SEGMENT.test(u)) return rt.abort(); // segments: record nothing, save bandwidth
    if (MEDIA.test(u) && (ty === "media" || /\.(m3u8|mpd)(\?|$)/i.test(u))) {
      try {
        const key = u.split("?")[0] as string;
        media.set(key, (media.get(key) ?? 0) + 1);
      } catch {
        /* ignore */
      }
      if (ty === "media" && /\.mp4(\?|$)/i.test(u)) return rt.abort(); // URL recorded; bytes fetched later by validateStream
    }
    return rt.continue();
  });

  armIdleClose();
  try {
    say("goto");
    await page.goto(o.url, { waitUntil: "commit", timeout: 25000 });
    await page
      .waitForLoadState("domcontentloaded", { timeout: 15000 })
      .catch(() => {});
    await waitForContent(page, Math.min(10000, left()));
    await dismiss(page);

    say("play");
    const w = await firstVisible(page, o.playSelectors);
    if (w) {
      await domClick(page, w);
      await page.waitForTimeout(3500);
    } else {
      say("no play button");
    }

    // the player (often an external embed iframe) attaches a few seconds later
    const t1 = Date.now();
    while (Date.now() - t1 < 9000 && left() > 5000) {
      if (
        page
          .frames()
          .some((f) => f !== page.mainFrame() && /^https?:/.test(f.url()))
      )
        break;
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1500);

    if (o.panelSelectors?.length) {
      say("panel");
      await page.mouse.move(640, 400).catch(() => {});
      const p = await firstVisible(page, o.panelSelectors);
      if (p) await domClick(page, p);
      await page.waitForTimeout(1500);
    }
    if (o.serverName) {
      say(`server:${o.serverName}`);
      await clickServer(page, o.serverName);
      await page.waitForTimeout(2500);
    }

    say("scan");
    let servers: string[] = [];
    for (let k = 0; k < 3 && servers.length < 2 && left() > 4000; k++) {
      servers = await scanSwitchers(page);
      if (servers.length < 2) await page.waitForTimeout(1500);
    }
    const frames = page
      .frames()
      .map((f) => f.url().slice(0, 160))
      .filter((u) => u && u !== "about:blank");
    say(`done servers=[${servers.join(",")}] media=${media.size}`);
    return { servers, media: [...media.keys()], frames, landedUrl: page.url() };
  } finally {
    await ctx.close().catch(() => {});
  }
}
