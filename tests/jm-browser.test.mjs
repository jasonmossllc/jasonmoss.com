// js/jm.js in a real browser (headless Chromium through Playwright): what the script sends for Back navigation,
// untouched and touched views, held reading time, and the Kit identity parameters before consent.
//
// Playwright isn't a dependency of the site (Netlify would install it on every deploy), so these tests SKIP unless it
// can be imported: run them with a local copy, e.g.
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node --test tests/jm-browser.test.mjs
// (Chromium installed by `npx playwright install chromium`). Run them before pushing a change to js/jm.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

let chromium = null;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")); } catch { /* skipped below */ }
const skip = chromium ? false : "Playwright isn't installed (set PLAYWRIGHT_MODULE to run these)";

const JM = readFileSync(new URL("../js/jm.js", import.meta.url), "utf8");
let batches = [];
// A page with the script as the edge function adds it; data-c = the consent mode (g = go, r = ask first).
const page = (title, body, mode = "g") => `<!doctype html><html><head><title>${title}</title><script src="/js/jm.js" data-c="${mode}" async></script></head>`
  + `<body style="margin:0">${body}<div style="height:3000px"></div></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/js/jm.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(JM); }
  if (u.pathname === "/_jm/e") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { batches.push(JSON.parse(b)); } catch { /* ignore */ } res.writeHead(204); res.end(); });
    return;
  }
  // no-store: never restored from the back/forward cache (like an in-app browser without one), so Back loads again.
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "set-cookie": "jm_vid=AAAAAAAAAAAAAAAAAAAAAA; Path=/" });
  if (u.pathname === "/a/") return res.end(page("A", '<a id="go" href="/b/">next</a> <button id="btn">btn</button>'));
  if (u.pathname === "/eu/") return res.end(page("EU", "<p>x</p>", "r"));
  return res.end(page("B", "<p>thank you</p>"));
});
let base, browser;
before(async () => {
  if (skip) return;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); server.close(); });

async function newPage() {
  const ctx = await browser.newContext();
  // The script stays quiet in automated browsers; these tests are the exception.
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  return ctx.newPage();
}
const events = () => batches.flatMap((b) => b.e);
const pageViews = () => events().filter((e) => e.t === "pv");
const settle = (p, ms) => p.waitForTimeout(ms);

test("Back to a page that isn't restored from the cache counts only once it stays on screen", { skip }, async () => {
  batches = [];
  const p = await newPage();
  await p.goto(`${base}/a/`);
  await settle(p, 600);
  await p.click("#go");
  await p.waitForURL("**/b/");
  await settle(p, 600);
  await p.goBack();
  await settle(p, 700); // gone again within 1.5 s (an in-app browser closing)
  await p.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(pageViews().map((e) => new URL(e.u).pathname), ["/a/", "/b/"]);

  batches = [];
  const q = await newPage();
  await q.goto(`${base}/a/`);
  await settle(q, 400);
  await q.click("#go");
  await q.waitForURL("**/b/");
  await settle(q, 400);
  await q.goBack();
  await settle(q, 2200); // stays: that's a view of it
  await q.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(pageViews().map((e) => new URL(e.u).pathname), ["/a/", "/b/", "/a/"]);
});

test("a view nobody touched says so (h 0, no active time); the first interaction credits the reading time held before it", { skip }, async () => {
  batches = [];
  const p = await newPage();
  await p.goto(`${base}/b/`);
  await settle(p, 1500);
  await p.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 400));
  const pv = pageViews()[0];
  assert.ok(pv && !pv.h, "untouched view");
  assert.ok(events().filter((e) => e.t === "pu").every((e) => e.a === 0 && !e.h));

  batches = [];
  const q = await newPage();
  await q.goto(`${base}/a/`);
  await settle(q, 3000);
  await q.click("#btn");
  await settle(q, 300);
  await q.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 400));
  const last = events().filter((e) => e.t === "pu").pop();
  assert.ok(last.h === 1 && last.a >= 2500 && last.a <= 120000, JSON.stringify(last));
});

test("a page reloaded by the browser says so on its page view", { skip }, async () => {
  batches = [];
  const p = await newPage();
  await p.goto(`${base}/b/`);
  await settle(p, 500);
  await p.reload();
  await settle(p, 800);
  await p.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(pageViews().map((e) => e.n || null), [null, "r"]);
});

test("Kit's identity parameters leave the address bar before any consent decision; the landing page view keeps them", { skip }, async () => {
  batches = [];
  const sh = "a".repeat(64);
  const p = await newPage();
  await p.goto(`${base}/eu/?utm_source=kit&ck_subscriber_id=12345&sh_kit=${sh}`);
  await settle(p, 800);
  assert.equal(new URL(p.url()).search, "?utm_source=kit", "stripped while the consent notice waits");
  assert.equal(batches.length, 0, "nothing sent before consent");
  await p.click("#jm-consent .jm-y").catch(() => {}); // the consent call itself fails here (no edge): nothing starts
  await p.close();

  const q = await newPage();
  await q.goto(`${base}/a/?ck_subscriber_id=12345&sh_kit=${sh}`);
  await settle(q, 800);
  assert.equal(new URL(q.url()).search, "");
  await q.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 400));
  const pv = pageViews()[0];
  assert.ok(pv.u.includes("ck_subscriber_id=12345") && pv.u.includes(`sh_kit=${sh}`));
  assert.ok(events().some((e) => e.t === "id" && e.k === "kit" && e.kid === "12345"));
});
