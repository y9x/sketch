import { getExposedWindow } from "./consts";
import { hookContext, mirrorAttributes } from "./hook";
import { shouldBlockURL } from "./cheats/adblock";

const window = getExposedWindow();

hookContext(window);

export function setInjectValues(_values: Record<string, any>) {
  // Non-enumerable so the global stays out of Object.keys(window) and for-in.
  Object.defineProperty(window, "__sketchInject", {
    value: _values,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

let { call: c } = (() => {}).bind;
// no get() allowed
c.bind = c.bind;
let str_in = c.bind(String.prototype.includes);
let ele_rm = c.bind(Element.prototype.remove);

// Map Krunker game-ID region prefixes to matchmaker region codes
const REGION_TO_MATCHMAKER: Record<string, string> = {
  NY: "us-nj",
  SV: "us-ca-sv",
  DAL: "us-tx",
  MIA: "us-fl",
  STL: "us-wa",
  CHI: "us-il",
  MX: "mx-cmx",
  BRZ: "brz",
  BHN: "me-bhn",
  TOK: "jb-hnd",
  SIN: "sgp",
  SEO: "as-seoul",
  MBI: "as-mb",
  FRA: "de-fra",
  LON: "gb-lon",
  AFR: "af-ct",
  SYD: "au-syd",
  SSS: "sss",
  IOW: "iow",
};

function unspoofSeekUrl(url: string): string {
  try {
    const raw = sessionStorage.getItem("_sk_spoof");
    if (!raw) return url;
    const data = JSON.parse(raw) as { fake: string; real: string };
    if (!data.fake || !data.real) return url;

    // Replace fake game ID with real (both encoded and raw)
    let result = url;
    if (result.includes(encodeURIComponent(data.fake))) {
      result = result.replace(
        encodeURIComponent(data.fake),
        encodeURIComponent(data.real),
      );
    } else if (result.includes(data.fake)) {
      result = result.replace(data.fake, data.real);
    }

    // Restore real matchmaker region based on real game ID prefix
    const realRegionPrefix = data.real.split(":")[0];
    const realMatchmaker = REGION_TO_MATCHMAKER[realRegionPrefix];
    if (realMatchmaker) {
      result = result.replace(
        /([?&]region=)[^&]+/,
        `$1${encodeURIComponent(realMatchmaker)}`,
      );
    }

    return result;
  } catch {}
  return url;
}

function cleanStack(e: any): never {
  if (e instanceof Error && e.stack) {
    e.stack = e.stack
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("at ") || line.includes("krunker.io"),
      )
      .join("\n");
  }
  throw e;
}

const ogFetch = window.fetch;
const _fetch = c.bind(ogFetch);

// Pass /seek-game through with game-ID unspoof; the real matchmaking token
// arrives via arguments[0] from the WASM loader, not from an iframe.
window.fetch = mirrorAttributes(
  function (this: any, url, init) {
    if (typeof url === "string" && str_in(url, "/seek-game")) {
      return (_fetch(this, unspoofSeekUrl(url), init) as Promise<Response>).catch(cleanStack);
    }
    return (_fetch(this, url, init) as Promise<Response>).catch(cleanStack);
  } as typeof fetch,
  ogFetch,
);

// Keep Sketch's document-start DOM filtering, but source acquisition and stock
// loader suppression now belong exclusively to loader/neutralize.ts.
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (let i = 0; i < mutation.addedNodes.length; i++) {
      const node = mutation.addedNodes[i] as HTMLElement;
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = node.tagName;
      if (tag === "SCRIPT") {
        const src = (node as HTMLScriptElement).src;
        if (src && shouldBlockURL(src)) ele_rm(node);
      } else if (tag === "IFRAME" || tag === "IMG" || tag === "LINK") {
        const url =
          (node as HTMLIFrameElement).src || (node as HTMLLinkElement).href;
        if (url && shouldBlockURL(url)) ele_rm(node);
      }
    }
  }
});

observer.observe(document, { childList: true, subtree: true });
