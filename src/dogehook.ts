import { getExposedWindow, isDevelopment, isKrunker } from "./consts";
import { hookContext, mirrorAttributes, setNativeFunction } from "./hook";
import { shouldBlockURL } from "./cheats/adblock";

const window = getExposedWindow();

hookContext(window);

export type SourceInterceptor = (
  url: string,
  responseText: string,
) => string | undefined;

let interceptor: SourceInterceptor | undefined;

export function setSourceInterceptor(fn: SourceInterceptor) {
  interceptor = fn;
}

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

const GAME_SOURCE_MIN = 5_000_000;

function init(): Promise<void> {
  // NOTE: an Object.prototype lockdown guard used to live here -- wrappers
  // around Object.preventExtensions/seal/freeze and Reflect.preventExtensions,
  // plus a WebAssembly.instantiateStreaming scanner that looked for those
  // functions in the WASM import object. None of it ever fired: the
  // '[sketch] blocked Object.prototype lockdown' line never logged once, yet
  // Object.prototype still flipped from extensible to non-extensible between
  // document-start and the game source running. Removed, because
  // game/render/overlay are now captured by source patches in filters.ts and
  // nothing depends on Object.prototype staying extensible.

  // Emscripten's UTF8ToString uses a cached TextDecoder instance created at
  // module scope. Hook the prototype method BEFORE the loader module parses
  // (we run at document-start). The 8.6MB game source passes through here.
  // Replace the TextDecoder constructor (static property on window, not prototype)
  // so instances created after this point get an instance-level decode override.
  // Prototype stays untouched -- only the constructor reference on window changes.
  const OrigTD = window.TextDecoder;
  const origProtoDecode = OrigTD.prototype.decode;
  let intercepted = false;

  const FakeTD = function TextDecoder(this: any, ...args: any[]) {
    const instance = new (OrigTD as any)(...args);
    if (intercepted) return instance;

    const decode = setNativeFunction(
      function (input?: BufferSource, options?: TextDecodeOptions) {
        const result = origProtoDecode.call(instance, input as any, options);

        if (
          intercepted ||
          !interceptor ||
          typeof result !== "string" ||
          result.length <= GAME_SOURCE_MIN
        )
          return result;

        intercepted = true;
        // Uninstall before returning so no own 'decode' or swapped global remains.
        delete (instance as any).decode;
        (window as any).TextDecoder = OrigTD;

        if (isDevelopment)
          console.log(
            "[sketch] intercepted game source:",
            result.length,
            "chars",
          );

        const patched = interceptor("Function", result);
        if (patched === undefined) return result;

        if (isDevelopment)
          console.log(
            "[sketch] injected patched source:",
            patched.length,
            "chars",
          );

        return patched;
      },
      "decode",
      { length: 1 },
    );

    Object.defineProperty(instance, "decode", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: decode,
    });

    return instance;
  } as unknown as typeof TextDecoder;

  // Not isConstructor: leaves OrigTD.prototype.constructor honest.
  mirrorAttributes(FakeTD, OrigTD);
  FakeTD.prototype = OrigTD.prototype;
  (window as any).TextDecoder = FakeTD;

  if (isDevelopment) console.log("[sketch] TextDecoder constructor replaced");

  return new Promise<void>((loaded) => {
    let resolved = false;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (let i = 0; i < mutation.addedNodes.length; i++) {
          const node = mutation.addedNodes[i] as HTMLElement;
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const tag = node.tagName;

          if (tag === "SCRIPT") {
            const src = (node as HTMLScriptElement).src;

            if (
              src &&
              (str_in(src, "/static/index-") || str_in(src, "/pkg/loader-"))
            ) {
              // Deliberately left in the document: the TextDecoder hook needs
              // the real loader to run so it can swap the decoded source.
              if (!resolved) {
                resolved = true;
                loaded();
              }
            } else if (src && shouldBlockURL(src)) {
              ele_rm(node);
            }
          } else if (tag === "IFRAME" || tag === "IMG" || tag === "LINK") {
            const url =
              (node as HTMLIFrameElement).src ||
              (node as HTMLLinkElement).href;
            if (url && shouldBlockURL(url)) {
              ele_rm(node);
            }
          }
        }
      }
    });

    // Never disconnected: adblock filtering has to keep running all session.
    observer.observe(document, {
      childList: true,
      subtree: true,
    });
  });
}

export const gameLoad: Promise<void> = isKrunker
  ? init()
  : new Promise<void>(() => {});
