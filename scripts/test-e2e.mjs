import { chromium } from "/home/user/src/krunkbox/node_modules/patchright/index.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY = "http://127.0.0.1:8888";
const KRUNKBOX = "http://127.0.0.1:3001/";
const TIMEOUT = Number(process.env.E2E_TIMEOUT ?? 120_000);

async function main() {
  console.log("[e2e] reading sketch bundle...");
  const sketchBundle = await readFile(join(__dirname, "../dist/sketch.user.js"), "utf-8");
  const sketchCode = sketchBundle.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, "");
  console.log(`[e2e] sketch bundle: ${sketchCode.length} chars`);

  const tokenResponse = await fetch(new URL("hi", KRUNKBOX), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "sketch-integrated-e2e" }),
  });
  if (!tokenResponse.ok) throw new Error(`KrunkBox token failed: ${tokenResponse.status}`);
  const { token } = await tokenResponse.json();

  const loaderResponse = await fetch(new URL("loader/current.json", KRUNKBOX));
  if (!loaderResponse.ok) throw new Error(`KrunkBox loader manifest failed: ${loaderResponse.status}`);
  const { build: currentBuild } = await loaderResponse.json();
  if (typeof currentBuild !== "string" || !currentBuild) {
    throw new Error("KrunkBox loader manifest has no build id");
  }
  console.log(`[e2e] KrunkBox build: ${currentBuild}`);

  console.log("[e2e] launching browser...");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    proxy: { server: PROXY, bypass: "127.0.0.1,localhost" },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === "error") console.error("[browser]", text);
    else console.log(`[browser:${type}]`, text);
  });
  page.on("pageerror", (err) => console.error("[browser:pageerror]", err));

  const gmShim = `
    if (typeof unsafeWindow === "undefined") window.unsafeWindow = window;
    if (typeof GM_getValue === "undefined") {
      const _store = { token: ${JSON.stringify(token)} };
      window.GM_getValue = (k, d) => k in _store ? _store[k] : d;
      window.GM_setValue = (k, v) => { _store[k] = v; };
      window.GM_deleteValue = (k) => { delete _store[k]; };
      window.GM_listValues = () => Object.keys(_store);
    }
    if (typeof GM_openInTab === "undefined") {
      window.GM_openInTab = (url) => window.open(url);
    }
    if (typeof GM_xmlhttpRequest === "undefined") {
      window.GM_xmlhttpRequest = (opts) => {
        const ctrl = new AbortController();
        fetch(opts.url, {
          method: opts.method || "GET",
          headers: opts.headers || {},
          body: opts.data || opts.body || undefined,
          signal: ctrl.signal,
        }).then(async (res) => {
          const text = await res.text();
          const resp = {
            status: res.status,
            statusText: res.statusText,
            responseHeaders: [...res.headers].map(([k,v]) => k+": "+v).join("\\r\\n"),
            responseText: text,
            response: text,
            finalUrl: res.url,
          };
          if (opts.onload) opts.onload(resp);
        }).catch((err) => {
          if (opts.onerror) opts.onerror(err);
        });
        return { abort: () => ctrl.abort() };
      };
    }
  `;

  // Playwright init scripts run before page scripts on every navigation. This
  // is more reliable than mutating HTML (which can be blocked by CSP and can
  // inject twice when Krunker redirects/reloads its main document).
  await page.addInitScript({
    content: `
      if (window === window.top && location.hostname === "krunker.io") {
        ${gmShim}
        ${sketchCode}
      }
    `,
  });
  const requests = [];

  page.on("request", (request) => requests.push(request.url()));

  await page.route("**/*", async (route) => {
    const req = route.request();
    let url;
    try { url = new URL(req.url()); } catch { return route.abort(); }

    if (url.href.startsWith(KRUNKBOX)) {
      const upstream = await fetch(url, {
        method: req.method(),
        headers: req.headers(),
        body: req.postDataBuffer() || undefined,
      });
      return route.fulfill({
        status: upstream.status,
        headers: Object.fromEntries(upstream.headers),
        body: Buffer.from(await upstream.arrayBuffer()),
      });
    }

    const isKru = url.hostname === "krunker.io" || url.hostname.endsWith(".krunker.io");
    const isSketchApi = url.hostname === "kru.eli.gift" || url.origin === new URL(KRUNKBOX).origin;
    if (!isKru && !isSketchApi) {
      return route.abort();
    }

    // all other requests: pass through the browser proxy
    return route.continue();
  });

  // The development proxy may retain an HTML response across Krunker deploys.
  // A unique document URL keeps the HTML loader build aligned with its splits.
  const gameUrl = new URL("https://krunker.io/");
  gameUrl.searchParams.set("_sketchE2E", String(Date.now()));
  console.log(`[e2e] navigating to ${gameUrl.href} ...`);
  await page.goto(gameUrl.href, { waitUntil: "load", timeout: 60000 });
  console.log("[e2e] page loaded, waiting for game...");

  const deadline = Date.now() + TIMEOUT;
  let gameLoaded = false;
  let loaderFinished = false;
  let loaderFailed = false;
  let hasSketchButton = false;
  while (Date.now() < deadline) {
    try {
      ({ gameLoaded, loaderFinished, loaderFailed, hasSketchButton } = await page.evaluate(() => {
        const consent = document.getElementById("consentBlock");
        if (consent && getComputedStyle(consent).display !== "none") {
          if (typeof checkTerms === "function") {
            checkTerms(1);
          } else {
            const accept = [...document.querySelectorAll(".termsBtn")].find(
              (element) => element.textContent?.trim() === "Accept",
            );
            if (accept instanceof HTMLElement) accept.click();
          }
        }
        const stage = window.__sketchLoader?.stage;
        const captures = window.__sketchE2ECaptures || {};
        return {
          gameLoaded: !!(window.gameLoaded || window.Game || captures.game),
          loaderFinished: stage === "done" || stage === "failed" || stage === "restored",
          loaderFailed: stage === "failed" || stage === "restored",
          hasSketchButton: !!document.getElementById("sketchMenuButton"),
        };
      }, undefined, undefined, false));
    } catch { break; }
    if ((loaderFinished && hasSketchButton && gameLoaded) || loaderFailed) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  const state = await page.evaluate(() => ({
    gameLoaded: !!window.gameLoaded,
    hasGame: !!window.Game,
    hasGUI: !!window.GUI,
    hasSketchInject: !!window.__sketchInject,
    hasSketchButton: !!document.getElementById("sketchMenuButton"),
    consentVisible: !!document.getElementById("consentBlock") &&
      getComputedStyle(document.getElementById("consentBlock")).display !== "none",
    loader: window.__sketchLoader ? {
      stage: window.__sketchLoader.stage,
      buildId: window.__sketchLoader.buildId,
      error: window.__sketchLoader.error,
      integrated: window.__sketchLoader.log.some((line) =>
        line.includes("stage: integrated"),
      ),
    } : null,
  }), undefined, undefined, false).catch(() => ({}));

  const localArtifact = requests.some((url) =>
    url.startsWith(KRUNKBOX) && /\/loader\/[^/]+\/keystream\.bin$/.test(url),
  );
  const processedArtifact = requests.some((url) =>
    url.startsWith(KRUNKBOX) && /\/loader\/[^/]+\/source\.js$/.test(url),
  );
  const stockLoaderWasm = requests.some((url) => /loader-[^/]+\.wasm/.test(url));
  const passed = gameLoaded && state.loader?.stage === "done" &&
    state.loader.integrated && state.hasSketchInject && state.hasSketchButton &&
    localArtifact && processedArtifact &&
    !stockLoaderWasm && !state.consentVisible;

  console.log("[e2e] Game state:", state);
  console.log("[e2e] local artifact:", localArtifact);
  console.log("[e2e] processed artifact:", processedArtifact);
  console.log("[e2e] stock loader WASM:", stockLoaderWasm);
  console.log("[e2e] loader requests:", requests.filter((url) =>
    /core\.dat-|loader-|generate-token|\/loader\//.test(url),
  ));

  if (passed) {
    console.log("[e2e] \x1b[32mSUCCESS: integrated Sketch loader executed the game\x1b[0m");
  } else {
    console.error("[e2e] \x1b[31mFAILED: game did not load within", TIMEOUT / 1000, "seconds\x1b[0m");
    const failureState = await page.evaluate(() => ({
      title: document.title,
      bodyLen: document.body?.innerHTML?.length || 0,
      hasConsentBlock: !!document.getElementById("consentBlock"),
      consentVisible: document.getElementById("consentBlock")?.style?.display !== "none",
      hasInstructionHolder: !!document.getElementById("instructionHolder"),
      hasMenuHolder: !!document.getElementById("menuHolder"),
      scriptCount: document.querySelectorAll("script").length,
      iframeCount: document.querySelectorAll("iframe").length,
      errors: (window.__e2eErrors || []).slice(-5),
      bodySnippet: document.body?.innerHTML?.slice(0, 500) || "",
    }), undefined, undefined, false).catch((e) => ({ error: String(e) }));
    console.log("[e2e] Page state:", JSON.stringify(failureState, null, 2));
  }

  await browser.close();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("[e2e] Fatal:", err);
  process.exit(1);
});
