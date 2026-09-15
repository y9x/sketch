import { getExposedWindow, isDevelopment } from "./consts";
import type Game from "./krunker/Game";
import type MapObject from "./krunker/Object";
import { Player } from "./krunker/Player";
import type RenderManager from "./krunker/RenderManager";
import type configModule from "./krunker/config";
import type * as Overlay from "./krunker/overlay";
import sketchConfig, { skyboxes } from "./sketchConfig";
import { console, defineProperty } from "./crashout";
import { hookContext, mirrorAttributes } from "./hook";
import type KrunkBox from "./KrunkBox";
import type * as THREE from "three";
import type { MapData } from "./krunker/GameMap";
import { AI } from "./krunker/AI";
import type * as IO from "./krunker/io";
import { sessionStore } from "./sessionStore";
import { isOnEndScreen } from "./krunkerUtil";
import { waitFor } from "./util";

export const hitboxPoints = Symbol();

const canSee = Symbol();
let checkingCanSee = false;

export function canISeeEnt(ent: Player | AI) {
  if (canSee in ent) return ent[canSee];
  const game = getGame();
  const localPlayer = getLocalPlayer();

  checkingCanSee = true;
  const s =
    ogCanSee!.call(
      game,
      window.spectating && game.controls.spect.target
        ? game.controls.spect.target
        : localPlayer,
      ent.x,
      ent.y,
      ent.z,
    ) === null;
  checkingCanSee = false;
  ent[canSee] = s;
  return s;
}

declare module "./krunker/Player" {
  interface Player {
    [canSee]?: boolean;
    [hitboxPoints]?: THREE.Vector3[];
  }
}

declare module "./krunker/AI" {
  interface AI {
    [canSee]?: boolean;
    [hitboxPoints]?: THREE.Vector3[];
  }
}

let io: typeof IO | undefined;

export function getIO() {
  if (!io) throw new Error("Too early");
  return io;
}

export const onIoHooks: ((socket: WebSocket) => void)[] = [];

export const data: Record<string, any> = {
  /** Clan name → hex color. When set, the game's special clan color function returns this instead of gold. */
  clanColorOverrides: null as Record<string, string> | null,
  socket(t: typeof IO, prop: string | number, arg: string | URL) {
    if (isDevelopment) console.log("[sketch] data.socket called:", { target: typeof t, prop, url: String(arg) });
    io = t;
    // Page-realm constructor: frames must be page-realm ArrayBuffers or msgpack decoding fails
    const ws = new (getExposedWindow().WebSocket)(arg);
    if (isDevelopment) {
      ws.addEventListener("open", () => console.log("[sketch] ws open"));
      ws.addEventListener("error", (e) => console.error("[sketch] ws error", e));
      ws.addEventListener("close", (e) =>
        console.error("[sketch] ws close", {
          code: e.code,
          reason: e.reason,
          wasClean: e.wasClean,
        }),
      );
    }
    // console.log({ io, ws, prop, arg });
    for (const hook of onIoHooks) hook(ws);
    // @ts-ignore
    t[prop] = ws;
    return ws;
  },

  /**
   * Game constructor capture. The patch site is mid-constructor, so `attach`
   * and `players` don't exist yet -- defer the hooks until it's actually built.
   */
  captureGame(g: Game) {
    if (game) return g;
    game = g;
    if (isDevelopment) console.log("[sketch] captured game");

    // Runs mid-constructor: anything thrown here aborts Game's boot, and the
    // game swallows it, so the only symptom is a later "socket error".
    try {
      if (isDevelopment) {
        const w = getExposedWindow();
        w.addEventListener("error", (e) =>
          console.error("[sketch] uncaught:", e.message, e.filename, e.lineno),
        );
        w.addEventListener("unhandledrejection", (e) => {
          // The loader's capture listener prevents the expected empty-WASM
          // rejection before this DEV logger sees it. Do not report events
          // that another runtime component has already handled.
          if (e.defaultPrevented) return;
          console.error("[sketch] unhandled rejection:", e.reason);
        });
      }

      waitFor(
        () =>
          game &&
          (game as any).attach &&
          (game as any).players &&
          (game as any).controls &&
          (game as any).map,
        50,
        30e3,
      ).then(
        () => {
          try {
            doGameHooks();
          } catch (e) {
            if (isDevelopment) console.error("[sketch] doGameHooks failed:", e);
          }
        },
        (e) => {
          if (isDevelopment) console.error("[sketch] waitFor game failed:", e);
        },
      );
    } catch (e) {
      if (isDevelopment) console.error("[sketch] captureGame failed:", e);
    }

    return g;
  },

  /** render.sceneInit -> this.skyDomeInit(config); `this` is the RenderManager */
  captureRender(r: RenderManager) {
    if (render) return r;
    render = r;
    if (isDevelopment) console.log("[sketch] captured render");

    // Captured mid-sceneInit, so scene/camera/renderer don't exist yet and the
    // render wrapper reads game.players every frame.
    try {
      waitFor(
        () =>
          render &&
          (render as any).scene &&
          (render as any).camera &&
          (render as any).renderer &&
          game &&
          (game as any).players,
        50,
        30e3,
      ).then(
        () => {
          try {
            doRenderHooks();
            if (isDevelopment) console.log("[sketch] render hooks installed");
          } catch (e) {
            if (isDevelopment) console.error("[sketch] doRenderHooks failed:", e);
          }
        },
        (e) => {
          if (isDevelopment) console.error("[sketch] waitFor render failed:", e);
        },
      );
    } catch (e) {
      if (isDevelopment) console.error("[sketch] captureRender failed:", e);
    }

    return r;
  },

  /** overlay module init -> overlay.hideNames */
  captureOverlay(o: typeof Overlay) {
    if (overlay) return o;
    overlay = o;
    if (isDevelopment) console.log("[sketch] captured overlay");

    // hideNames is assigned ~640 lines before overlay.render. Wrapping now
    // would close over undefined and then be overwritten by the game's own
    // render assignment, so the overlay hooks would never run.
    try {
      waitFor(
        () => overlay && typeof (overlay as any).render === "function",
        50,
        30e3,
      ).then(
        () => {
          try {
            doOverlayHooks();
            if (isDevelopment) console.log("[sketch] overlay hooks installed");
          } catch (e) {
            if (isDevelopment)
              console.error("[sketch] doOverlayHooks failed:", e);
          }
        },
        (e) => {
          if (isDevelopment)
            console.error("[sketch] waitFor overlay failed:", e);
        },
      );
    } catch (e) {
      if (isDevelopment) console.error("[sketch] captureOverlay failed:", e);
    }

    return o;
  },

  /** SETTINGS constructor -> this['tmp']={},this['bundleMedalFilters']=... */
  captureSettings(s: Settings) {
    if (settings) return s;
    settings = s;
    if (isDevelopment) console.log("[sketch] captured settings");

    // Runs mid-constructor, so a throw here would abort SETTINGS' boot.
    try {
      doSettingsHooks();
    } catch (e) {
      if (isDevelopment) console.error("[sketch] doSettingsHooks failed:", e);
    }
    return s;
  },
};

export const beforeUpdateMenuAccountDataHooks: (() => void)[] = [];
export const afterUpdateMenuAccountDataHooks: (() => void)[] = [];

/** Last known account object captured from the Svelte store inside updateMenuAccountData. */
export let svelteAccountData: { name: string; alias: string; premiumT: number } | null = null;

data.onSvelteAccountData = function onSvelteAccountData(account: unknown) {
  if (account && typeof account === "object") {
    const a = account as Record<string, unknown>;
    svelteAccountData = {
      name: typeof a.name === "string" ? a.name : "",
      alias: typeof a.alias === "string" ? a.alias : "",
      premiumT: typeof a.premiumT === "number" ? a.premiumT : 0,
    };
    if (isDevelopment) console.log("HOOK: Svelte account data captured", svelteAccountData);
  }
};

data.wrapUpdateMenuAccountData = function wrapUpdateMenuAccountData<T extends Function>(
  updateMenuAccountData: T,
) {
  return mirrorAttributes(function (this: unknown, ...args: unknown[]) {
    for (const hook of beforeUpdateMenuAccountDataHooks) hook();

    const result = updateMenuAccountData.apply(this, args);

    for (const hook of afterUpdateMenuAccountDataHooks) hook();

    return result;
  }, updateMenuAccountData);
};

export const beforeSwitchLeaderboardHooks: (() => void)[] = [];

data.wrapSwitchLeaderboard = function wrapSwitchLeaderboard<T extends Function>(
  switchLeaderboard: T,
) {
  return mirrorAttributes(function (this: unknown, ...args: unknown[]) {
    for (const hook of beforeSwitchLeaderboardHooks) hook();

    return switchLeaderboard.apply(this, args);
  }, switchLeaderboard);
};

export const beforeAddChatI18NHooks: ((i18nArgs: unknown[]) => void)[] = [];

data.chatI18N = function chatI18N(i18nArgs: unknown[]) {
  for (const hook of beforeAddChatI18NHooks) {
    try {
      hook(i18nArgs);
    } catch {}
  }
};

export const patches: Record<
  string,
  [
    match: RegExp | string,
    replacer: (substring: string, ...args: any[]) => string,
  ]
> = {};

export const dataArg = "_" + Math.random().toString(36).slice(2);

const v = /(?<![a-zA-Z0-9_])[iIìíîïÌÍÎÏ]+(?![a-zA-Z0-9_])/;
// KrunkBox's final esbuild pass mangles identifiers to ordinary JS names.
const minifiedIdentifier = /[$A-Za-z_][$\w]*/;

patches.io = [
  new RegExp(
    `this\\.socket=new WebSocket\\((${minifiedIdentifier.source})\\),this\\.socket\\.binaryType="arraybuffer"`,
  ),
  (_, arg) =>
    `${dataArg}.socket(this,"socket",${arg}),this.socket.binaryType="arraybuffer"`,
];

const dp = Object.defineProperty;
data.object = Object.create(Object);

data.object.defineProperty = mirrorAttributes(
  function definePropertyHook(o: any, k: string, a: PropertyDescriptor) {
    if (k === "inventory" && typeof o === "object" && o !== null && o.id === -1) {
      defineProperty(o, "init", {
        configurable: true,
        set: (init) => {
          delete (o as any).init;
          (o as any).init = function (...args: any[]) {
            const menuSig = [0, 0, 0, "preview", false];
            if (menuSig.every((v, i) => args[i] === v)) {
              menuPlayer = o as Player;
            }
            return init.call(this, ...args);
          };
        },
      });
    }

    return dp(o, k, a);
  } as typeof Object.defineProperty,
  dp,
);

// Patch the special clan color function to check our clan color overrides first.
// Original: function sr(e,a){return typeof e=="string"&&["arae",...].includes(e.toLowerCase())?"#FBC02D":a}
// We wrap it so that if a clan name has a custom color override, that color is returned instead.
patches.specialClanColor = [
  /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{return typeof \2=="string"&&(\[[^\]]+\])\.includes\(\2\.toLowerCase\(\)\)\?"#FBC02D":\3\}/,
  (_: string, fnName: string, clanArg: string, fallbackArg: string, clans: string) => {
    return `function ${fnName}(${clanArg},${fallbackArg}){var _o=${dataArg}.clanColorOverrides;if(_o&&typeof ${clanArg}==="string"){var _k=${clanArg}.toLowerCase();if(_o[_k])return _o[_k]}return typeof ${clanArg}=="string"&&${clans}.includes(${clanArg}.toLowerCase())?"#FBC02D":${fallbackArg}}`;
  },
];

patches.updateMenuAccountData = [
  /window\.updateMenuAccountData=function\(\)\{([^}]*)\}/,
  (_, body) => {
    // Extract the account variable from STORE['set'](ACCOUNT_VAR)
    const setMatch = (body as string).match(/(?:\[['"]set['"]\]|\.set)\(([^)]+)\)/);
    const accountVar = setMatch?.[1];
    const capture = accountVar ? `${dataArg}.onSvelteAccountData(${accountVar});` : "";
    return `window.updateMenuAccountData=${dataArg}.wrapUpdateMenuAccountData(function(){${capture}${body}})`;
  },
];

patches.switchLeaderboard = [
  new RegExp(
    `window\\.switchLeaderboard=function\\((${minifiedIdentifier.source}),(${minifiedIdentifier.source})\\)\\{([^}]*leaderboardHolder[^}]*)\\}`,
  ),
  (_: string, arg1: string, arg2: string, body: string) => {
    return `window.switchLeaderboard=${dataArg}.wrapSwitchLeaderboard(function(${arg1},${arg2}){${body}})`;
  },
];

// Wrap the ADD_CHATI18N handler to let hooks modify the i18n args (e.g. spoof player names)
// Matches: function NAME(7 args){ body }window['switchChat']
// The 3rd arg is the i18n array: ["server.message.join", "PlayerName"]
patches.chatI18N = [
  new RegExp(
    `function\\s+(${minifiedIdentifier.source})\\((${minifiedIdentifier.source},${minifiedIdentifier.source},(${minifiedIdentifier.source}),${minifiedIdentifier.source},${minifiedIdentifier.source},${minifiedIdentifier.source},${minifiedIdentifier.source})\\)\\{([^}]*)\\}window\\.switchChat`,
  ),
  (_: string, fnName: string, allArgs: string, thirdArg: string, body: string) => {
    return `function ${fnName}(${allArgs}){Array.isArray(${thirdArg})||(${thirdArg}=[${thirdArg}]);${dataArg}.chatI18N(${thirdArg});${body}}window.switchChat`;
  },
];

// Game constructor in KrunkBox's esbuild output. The Players constructor also
// assigns this.isServer, but that one is followed by this.liveObjects, so
// anchoring on this.isClient uniquely selects Game.
// uniquely selects Game. Capture inside the existing comma chain.
patches.game = [
  new RegExp(
    `this\\.isServer=!!(${minifiedIdentifier.source}),this\\.isClient`,
  ),
  (_: string, arg: string) =>
    `this.isServer=!!${arg},${dataArg}.captureGame(this),this.isClient`,
];

// Render manager constructor: `,this['clearSkyDome']=function(){...}`, a method
// definition inside the constructor's comma chain, so it runs unconditionally at
// module init. The old skyDomeInit call site was gated on the map having a
// skyDome and no skyCol override, so it fired late or never. 'clearSkyDome' has
// exactly one literal occurrence outside the obfuscator string array.
patches.render = [
  /,this\.clearSkyDome=function\(\)/,
  () => `,${dataArg}.captureRender(this),this.clearSkyDome=function()`,
];

// Overlay module init chain: `<overlay>[..]=null,<overlay>['hideNames']=!0x1,`.
// Unconditional at module init, unlike the old updateMedalIcon anchor, which
// only ran on medal-icon update and so never fired. The other 'hideNames'
// literals are settings setters assigning a variable rather than !0x1, and the
// leading `]=null,` pins this to the init chain.
patches.overlay = [
  new RegExp(`=null,(${minifiedIdentifier.source})\\.hideNames=!1,`),
  (_: string, target: string) =>
    `=null,${dataArg}.captureOverlay(${target}).hideNames=!1,`,
];

// SETTINGS constructor: `this['tmp']={},this['bundleMedalFilters']=function(){`.
// The self-alias assigned just before it (`<var>=this`) is what the filter body
// closes over, confirming `tmp` and `bundleMedalFilters` share one owner, so
// `this` here is SETTINGS. Exactly one literal occurrence in the source.
patches.settings = [
  /this\.tmp=\{\},this\.bundleMedalFilters=function\(\)/,
  () =>
    `this.tmp={},${dataArg}.captureSettings(this),this.bundleMedalFilters=function()`,
];

// KrunkBox preserves the frozen config namespace as a null-prototype object.
// Capture that object directly instead of temporarily replacing Object.freeze;
// the source patch is deterministic and cannot miss due to realm/timing issues.
patches.config = [
  /([$\w]+)=Object\.freeze\((\{__proto__:null,(?=[\s\S]{0,15000}?gameVersion:)(?=[\s\S]{0,15000}?zombiePerks:)[\s\S]{0,15000}?zombiePerks:[^,}]+\})\)/,
  (_, configName, configObject) =>
    `${configName}=${dataArg}.captureConfig(Object.freeze(${configObject}))`,
];

// patches.lol = [new RegExp(`this\\[(${v.source}\\(0x[0-9a-f]+\\))\\]=new WebSocket\\(`), (_, prop) => `this[${prop}] = ${dataArg}.socket = new WebSocket(`];

// patches.UseStrict = [/"use strict";/, () => ""];

/* javascript-obfuscator:disable */

// called before game init: get ya hooks in
export const beforeGame: (() => void)[] = [];
// called after game init: pull out!
export const afterGame: (() => void)[] = [];

let ranBeforeGame = false;

export function runBeforeGameOnce() {
  if (ranBeforeGame) return;
  ranBeforeGame = true;
  // Isolated so one failing hook can't skip the rest.
  for (const bg of beforeGame) {
    try {
      bg();
    } catch (e) {
      if (isDevelopment) console.error("[sketch] beforeGame hook failed:", e);
    }
  }
}

// Must run first: every mirrorAttributes spoof below is inert until
// Function.prototype.toString is hooked to read the functionStrings map.
beforeGame.push(() => {
  hookContext(getExposedWindow(), undefined, false);
});

// --- Spoof Game ID in browser URL ---

const SPOOF_REGIONS = ["NY", "SV", "DAL", "MIA", "STL", "CHI", "MX", "BRZ", "BHN", "TOK", "SIN", "SEO", "MBI", "FRA", "LON", "AFR", "SYD", "SSS", "IOW"];

const REGION_FULL_NAMES: Record<string, string> = {
  NY: "New York",
  SV: "Silicon Valley",
  DAL: "Dallas",
  MIA: "Miami",
  STL: "Seattle",
  CHI: "Chicago",
  MX: "Mexico",
  BRZ: "Brazil",
  BHN: "Middle East",
  TOK: "Tokyo",
  SIN: "Singapore",
  SEO: "South Korea",
  MBI: "Mumbai",
  FRA: "Frankfurt",
  LON: "London",
  AFR: "South Africa",
  SYD: "Sydney",
  SSS: "EU Super Secret Servers",
  IOW: "Iowa",
};

export function generateFakeGameId() {
  const region = SPOOF_REGIONS[Math.floor(Math.random() * SPOOF_REGIONS.length)];
  const code = Math.random().toString(36).slice(2, 7);
  return `${region}:${code}`;
}

export let fakeGameId: string | null = null;
export let realGameId: string | null = null;

// Restore persisted spoof IDs from session storage
// Stored as { [fakeID]: realID } so multiple spoofed game IDs survive reloads.
{
  const stored = sessionStore.get<Record<string, string>>("spoof");
  if (stored && typeof stored === "object") {
    const href = location.href;
    for (const [fake, real] of Object.entries(stored)) {
      if (href.includes(fake)) {
        fakeGameId = fake;
        realGameId = real;
        // Sync to raw sessionStorage for dogehook iframe
        try {
          sessionStorage.setItem("_sk_spoof", JSON.stringify({ fake, real }));
        } catch {}
        break;
      }
    }
  }
}

export function persistSpoofIds() {
  if (fakeGameId && realGameId) {
    const stored = sessionStore.get<Record<string, string>>("spoof") ?? {};
    stored[fakeGameId] = realGameId;
    sessionStore.set("spoof", stored);
    // Also write to raw sessionStorage for dogehook (runs in iframe, no access to sessionStore)
    try {
      sessionStorage.setItem("_sk_spoof", JSON.stringify({ fake: fakeGameId, real: realGameId }));
    } catch {}
  }
}

function ensureFakeGameId() {
  if (!fakeGameId) {
    fakeGameId = generateFakeGameId();
    persistSpoofIds();
  }
  return fakeGameId;
}

function spoofUrlString(url: string): string {
  if (!sketchConfig.get("spoofGameId")) return url;
  // match game=REGION:CODE in query strings or paths
  const match = url.match(/([?&])game=([A-Z]{2,4}:[a-z0-9]{3,6})/);
  if (!match) return url;
  const gameId = match[2];
  // Already spoofed — don't touch it
  if (fakeGameId && gameId === fakeGameId) return url;
  realGameId = gameId;
  const fake = ensureFakeGameId();
  persistSpoofIds();
  return url.replace(gameId, fake);
}

export function updateRegionLabel() {
  try {
    const el = document.getElementById("menuRegionLabel");
    if (!el || !fakeGameId) return;
    if (!sketchConfig.get("spoofGameId")) return;
    const region = fakeGameId.split(":")[0];
    const fullName = REGION_FULL_NAMES[region];
    if (fullName) el.textContent = fullName;
  } catch {}
}

// On script load: if the URL contains a stored fake game ID, swap it back to
// On script load: if the URL has a stored fake game ID, keep it — the
// data.location proxy will transparently give the game the real ID.
// No need to swap the URL or regenerate a new fake ID.
{
  if (fakeGameId && realGameId) {
    const href = location.href;
    if (href.includes(fakeGameId)) {
      if (isDevelopment) console.log("SPOOF: on-load keeping fake ID in URL:", fakeGameId, "(real:", realGameId + ")");
    } else if (href.includes(realGameId)) {
      // URL has the real ID (e.g. navigated via a direct link) — spoof it
      if (isDevelopment) console.log("SPOOF: on-load found real ID in URL, spoofing to", fakeGameId);
      history.replaceState(document.title, document.title, href.replace(realGameId, fakeGameId));
    }
  }
}

// --- Spoof window["location"] and window["history"] in game source ---
data.location = new Proxy(location, {
  get(target, prop) {
    const value = (target as any)[prop];
    if (typeof value === "function") return value.bind(target);
    // Unspoof fake game ID back to real for href/search/hash so game code reads real ID
    if (fakeGameId && realGameId && typeof value === "string" && (prop === "href" || prop === "search" || prop === "hash")) {
      return value.replace(fakeGameId, realGameId);
    }
    return value;
  },
  set(target, prop, value) {
    (target as any)[prop] = value;
    return true;
  },
});

data.history = new Proxy(history, {
  get(target, prop) {
    const value = (target as any)[prop];
    if (typeof value !== "function") return value;

    if (prop === "pushState" || prop === "replaceState") {
      return function (stateData: any, unused: string, url?: string | URL | null) {
        if (url && sketchConfig.get("spoofGameId")) {
          const urlStr = typeof url === "string" ? url : url.toString();
          const spoofed = spoofUrlString(urlStr);
          if (isDevelopment && spoofed !== urlStr) console.log(`SPOOF: ${prop as string} spoofed URL`, urlStr, "->", spoofed);
          const result = (target as any)[prop](stateData, unused, spoofed);
          updateRegionLabel();
          return result;
        }
        return (target as any)[prop](stateData, unused, url);
      };
    }

    return value.bind(target);
  },
});

// KrunkBox's esbuild pass emits dot access. Route reads through the spoofing
// proxy while preserving the game's one real navigation assignment.
patches.spoofLocation = [
  /window\.location(?!\s*(?:=|\+=|-=|\+\+|--))/g,
  () => `${dataArg}.location`,
];

// History is only read in the processed source, so all accesses can use the
// wrapper that keeps pushed/replaced URLs spoofed.
patches.spoofHistory = [
  /window\.history/g,
  () => `${dataArg}.history`,
];

export function enableSpoofGameId() {
  fakeGameId = generateFakeGameId();
  // Parse the real game ID from the current URL if we don't have it yet
  const href = location.href;
  const match = href.match(/[?&]game=([A-Z]{2,4}:[a-z0-9]{3,6})/);
  if (match) realGameId = match[1];
  if (isDevelopment) console.log("SPOOF: enabled", { fakeGameId, realGameId });
  persistSpoofIds();
  if (realGameId && href.includes(realGameId)) {
    history.replaceState(document.title, document.title, href.replace(realGameId, fakeGameId));
    if (isDevelopment) console.log("SPOOF: replaced real ID in URL with fake");
  }
  updateRegionLabel();
}

export function disableSpoofGameId() {
  if (isDevelopment) console.log("SPOOF: disabled", { fakeGameId, realGameId });
  // Restore the real URL when disabled
  if (realGameId && fakeGameId) {
    const href = location.href;
    if (href.includes(fakeGameId)) {
      history.replaceState(document.title, document.title, href.replace(fakeGameId, realGameId));
      if (isDevelopment) console.log("SPOOF: restored real ID in URL");
    }
  }
  fakeGameId = null;
  realGameId = null;
  sessionStore.remove("spoof");
  try { sessionStorage.removeItem("_sk_spoof"); } catch {}
}

// Patch menuRegionLabel.textContent assignments to go through our spoof
patches.spoofRegionLabel = [
  /menuRegionLabel\.textContent\s*=/g,
  () => `${dataArg}.setRegionLabel(menuRegionLabel),menuRegionLabel.textContent=`,
];

data.setRegionLabel = function setRegionLabel(el: HTMLElement) {
  // After the game sets the region label, we override it with the fake region name
  if (!sketchConfig.get("spoofGameId") || !fakeGameId) return;
  setTimeout(() => {
    const region = fakeGameId!.split(":")[0];
    const fullName = REGION_FULL_NAMES[region];
    if (fullName) el.textContent = fullName;
  });
};

let config: typeof configModule | undefined;

export function getConfig() {
  if (!config) throw new Error("Too early");
  return config;
}

data.captureConfig = function captureConfig(o: typeof configModule) {
  config = o;
  if (isDevelopment) console.log("[sketch] captured config");
  return o;
};

/**
 * After the overlay is rendered
 * 2x slower than renderHooks
 * Used for game UI overlay
 */
export const overlayRenderHooks: (() => void)[] = [];
export const preOverlayRenderHooks: (() => void)[] = [];

/**
 * Called after any element's innerHTML is set.
 * Receives the element that was just written to.
 * Use for post-processing game-rendered DOM (leaderboard, scoreboard, end screen, etc.)
 */
export const innerHTMLHooks: ((element: Element) => void)[] = [];

beforeGame.push(() => {
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  if (!desc?.set) return;
  const originalSet = desc.set;

  defineProperty(Element.prototype, "innerHTML", {
    configurable: true,
    enumerable: true,
    get: desc.get,
    set(this: Element, value: string) {
      originalSet.call(this, value);
      if (innerHTMLHooks.length > 0) {
        for (const hook of innerHTMLHooks) {
          try {
            hook(this);
          } catch {}
        }
      }
    },
  });
});

let overlay: typeof Overlay | undefined;

export function getOverlay() {
  if (!overlay) throw new Error("Too early");
  return overlay;
}

type Settings = { tmp: Record<string, any>; bundleMedalFilters: () => void };

let settings: Settings | undefined;

export function getSettings() {
  if (!settings) throw new Error("Too early");
  return settings;
}

function doSettingsHooks() {
  const settings = getSettings();
  // `this['tmp']` was assigned `{}` immediately before our capture point, so
  // showFPS isn't set yet and the game's later write lands on the setter below.
  // The read covers the reverse order in case the anchor ever moves.
  let showFPS = settings.tmp?.showFPS;

  // Force the game to calculate FPS when the watermark is enabled. Safe because
  // the game still hides its own FPS element, so nothing extra becomes visible.
  defineProperty(settings.tmp, "showFPS", {
    enumerable: true,
    configurable: true,
    get: () => sketchConfig.get("watermark") || showFPS,
    set: (v) => {
      showFPS = v;
    },
  });
}

// NOTE: render/overlay used to be captured with an Object.prototype "render"
// accessor. That is unusable: the loader calls Object.preventExtensions on
// Object.prototype before the game source runs, and even when the trap did
// install (at document-start) the mere existence of an accessor named
// "render" hung the Emscripten loader, because every object then reports
// `'render' in obj === true`. Both are now captured via source patches
// (patches.render / patches.overlay) instead.

function doOverlayHooks() {
  if (isDevelopment) console.log("HOOK: setting up overlay render hooks");
  const overlay = getOverlay();
  const renderFn = overlay.render;

  overlay.render = mirrorAttributes(
    function (this: any, ...args: any[]) {
      // The overlay can render before Object.freeze captures the game config.
      // Skip only Sketch's callbacks during that short initialization window;
      // the game's own render must continue unconditionally.
      if (localPlayer && config)
        runHooks("preOverlayRenderHook", preOverlayRenderHooks);
      const result = renderFn.call(this, ...args);
      if (localPlayer && config)
        runHooks("overlayRenderHook", overlayRenderHooks);
      return result;
    } as typeof renderFn,
    renderFn,
  );
}

let render: RenderManager | undefined;

export function getRender() {
  if (!render) throw new Error("Too early");
  return render;
}

// this exists for hooking some rendering methods for stuff like skyboxes
export const renderObjHooks: (() => void)[] = [];

/**
 * After the 3D game is rendered
 * 2x faster than overlayRenderHooks
 * Used for THREE.js
 */
// export const gameRenderHooks: (() => void)[] = [];
export const preRenderHooks: (() => void)[] = [];

let conf: MapData | undefined;

export function getActiveMap() {
  if (!conf) throw new Error("Too early");
  return conf;
}

export function redrawSky() {
  try {
    // trigger an update

    // getRender().renderer.setClearColor(getRealClearColor());
    const render = getRender();
    const game = getGame();
    if (!conf) return;
    const id = render.lastEnvId;
    render.lastEnvId = null;
    render.init(conf, game.mode, true);
    render.updateShadowMap();
    render.lastEnvId = id;
    render.updateLightMap(conf);
  } catch (e) {
    //
    if (isDevelopment) console.error(e);
  }
}

function hexToRgb(hex: string) {
  const clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b };
  }

  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp >= 0 && hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function shiftHexHue(hex: string, hueDelta: number) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const h = ((hsl.h + hueDelta) % 360 + 360) % 360;
  const shifted = hslToRgb(h, hsl.s, hsl.l);

  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(shifted.r)}${toHex(shifted.g)}${toHex(shifted.b)}`;
}

function shiftOverrideColors(value: unknown, hueDelta: number): unknown {
  if (typeof value === "string") {
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)
      ? shiftHexHue(value, hueDelta)
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => shiftOverrideColors(item, hueDelta));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shiftOverrideColors(v, hueDelta);
    }
    return out;
  }

  return value;
}

const loadedSkyboxes: Record<string, THREE.Texture> = {};
const hueSkyboxes: Record<string, THREE.Texture> = {};
const hueSkyboxesLoading = new Set<string>();

function normalizeHue(value: number) {
  if (!Number.isFinite(value)) return 0;
  return ((Math.round(value) % 360) + 360) % 360;
}

async function toHueCanvas(face: CanvasImageSource, hueDeg: number) {
  const width = (face as any).naturalWidth || (face as any).videoWidth || (face as any).width;
  const height = (face as any).naturalHeight || (face as any).videoHeight || (face as any).height;
  if (!width || !height) throw new Error("invalid skybox face size");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  ctx.filter = `hue-rotate(${hueDeg}deg)`;
  ctx.drawImage(face, 0, 0, width, height);
  ctx.filter = "none";

  return canvas;
}

function warmHueSkybox(
  skyboxKey: string,
  hueDeg: number,
  baseTexture: THREE.Texture,
) {
  const hueKey = `${skyboxKey}:${hueDeg}`;
  if (hueSkyboxes[hueKey] || hueSkyboxesLoading.has(hueKey)) return;
  hueSkyboxesLoading.add(hueKey);

  const render = getRender();
  const THREE = render.THREE;
  const base = baseTexture as any;
  const faces = Array.isArray(base.image) ? base.image : [];
  if (faces.length !== 6) {
    hueSkyboxesLoading.delete(hueKey);
    return;
  }

  Promise.all(faces.map((face: CanvasImageSource) => toHueCanvas(face, hueDeg)))
    .then((canvases) => {
      const tex = new THREE.CubeTexture(canvases as any);
      tex.needsUpdate = true;

      // Keep key texture settings aligned with the original loaded cube texture.
      (tex as any).mapping = (base as any).mapping;
      (tex as any).magFilter = (base as any).magFilter;
      (tex as any).minFilter = (base as any).minFilter;
      (tex as any).generateMipmaps = (base as any).generateMipmaps;
      if ("colorSpace" in base) (tex as any).colorSpace = (base as any).colorSpace;
      if ("encoding" in base) (tex as any).encoding = (base as any).encoding;

      hueSkyboxes[hueKey] = tex as unknown as THREE.Texture;
    })
    .catch(() => {
      // Ignore hue transform failures and keep using base skybox.
    })
    .finally(() => {
      hueSkyboxesLoading.delete(hueKey);
    });
}

function getTech() {
  const skybox = sketchConfig.get("skybox");
  if (skybox === "off") return null;
  const s = skyboxes[skybox];
  if (!s) return null;
  let tech = loadedSkyboxes[skybox];
  if (!tech) {
    // 'posx.jpg', 'negx.jpg', 'posy.jpg', 'negy.jpg', 'posz.jpg', 'negz.jpg'
    const render = getRender();
    const THREE = render.THREE;
    const textureLoader = new THREE.CubeTextureLoader();
    tech = textureLoader.load(s.faces);
    loadedSkyboxes[skybox] = tech;
  }

  const hue = normalizeHue(sketchConfig.get("skyboxHue"));
  if (hue === 0) return tech;

  const hueKey = `${skybox}:${hue}`;
  const hueTech = hueSkyboxes[hueKey];
  if (hueTech) return hueTech;

  warmHueSkybox(skybox, hue, tech);
  return tech;
}

function doRenderHooks() {
  if (isDevelopment) console.log("HOOK: setting up render hooks");
  const render = getRender();
  const { init } = render;

  // <patched, og>
  const maps = new WeakMap<any, any>();

  render.init = mirrorAttributes(
    function (this: any, config: any, mode: any, idk1: any, idk2: any) {
      if (maps.has(config)) config = maps.get(config);

      let nConfig = config;

      conf = config;
      nConfig = { ...config };
      const hideVisuals = sketchConfig.get("hideVisualsEndScreen") && isOnEndScreen();
      if (!hideVisuals && sketchConfig.get("mapOverrides")) {
        const overridesHue = normalizeHue(sketchConfig.get("mapOverridesHue"));
        const overrides = sketchConfig.get("mapOverridesCode");
        const adjusted =
          overridesHue === 0
            ? overrides
            : (shiftOverrideColors(overrides, overridesHue) as MapData);
        Object.assign(nConfig, adjusted);
      }
      if (!hideVisuals && sketchConfig.get("skyColor"))
        Object.assign(nConfig, {
          skyDome: false,
          sky: sketchConfig.get("skyColorHex"),
        });
      maps.set(nConfig, config);

      init.call(this, nConfig, mode, idk1, idk2);
    } as typeof init,
    init,
  );

  let lastThirdPerson: boolean | undefined;
  let lastEndScreen: boolean | undefined;
  let skyConf = ["mapOverrides", "mapOverridesCode", "mapOverridesHue", "skyColor", "skyColorHex", "skyboxHue", "hideVisualsEndScreen"];
  sketchConfig.configTarget.addEventListener("change", (e) => {
    if (typeof e.configKey === "string" && skyConf.includes(e.configKey))
      redrawSky();
  });

  const renderFn = render.render;
  // we hook the render way too early
  render.render = mirrorAttributes(
    function (this: any, ...args: any[]) {
      if (game) {
        for (const player of game.players.list) delete player[canSee];
        for (const ai of game.AI.ais) delete ai[canSee];

        // redraw sky when end screen state transitions (so overrides toggle on/off)
        if (sketchConfig.get("hideVisualsEndScreen")) {
          const onEnd = isOnEndScreen();
          if (lastEndScreen !== onEnd) {
            lastEndScreen = onEnd;
            redrawSky();
          }
        }

        if (localPlayer) {
          runHooks("preRenderHook", preRenderHooks);

          if (game.config.thirdPerson !== lastThirdPerson) {
            try {
              game.players.regenMeshes(getLocalPlayer());
              lastThirdPerson = game.config.thirdPerson;
            } catch {}
          }
        }
      }

      const result = renderFn.call(this, ...args);
      // if (localPlayer) for (const hook of gameRenderHooks) hook();
      return result;
    } as typeof renderFn,
    renderFn,
  );

  // toggle clouds
  const wrapLoadTexture = (
    value: RenderManager["loadTexture"],
  ): RenderManager["loadTexture"] =>
    function (this: any, mat, id, data, crap) {
      const ret = value.call(this, mat, id, data, crap);
      if (data.src === "clouds_0" || data.emissive === "#FFC980") {
        let visible = mat.visible;
        Object.defineProperty(mat, "visible", {
          get: () => (sketchConfig.get("hideClouds") &&
          !(sketchConfig.get("hideVisualsEndScreen") && isOnEndScreen())
            ? false
            : visible),
          set: (v) => (visible = v),
        });
      }

      return ret;
    };

  // These hooks can run after the game already assigned the property, in which
  // case a write-only accessor would make every read return undefined.
  if (typeof (render as any).loadTexture === "function") {
    render.loadTexture = wrapLoadTexture(render.loadTexture);
  } else {
    defineProperty(render, "loadTexture", {
      configurable: true,
      set(value: RenderManager["loadTexture"]) {
        delete (render as any).loadTexture;
        render.loadTexture = wrapLoadTexture(value);
      },
    });
  }

  const threeRenderFn = render.renderer.render;
  render.renderer.render = mirrorAttributes(
    function (this: any, scene: any, camera: any) {
      if (camera === render.camera) {
        const hideVisuals = sketchConfig.get("hideVisualsEndScreen") && isOnEndScreen();
        render.scene.background = hideVisuals ? null : getTech();
        let ret = threeRenderFn.call(this, scene, camera);
        render.scene.background = null;
        return ret;
      }
      return threeRenderFn.call(this, scene, camera);
    } as typeof threeRenderFn,
    threeRenderFn,
  );

  const genericAdsArray = [...Array(64)].fill(0);
  let ogAds = render.adsFov;
  defineProperty(render, "adsFov", {
    get: () => {
      if (!sketchConfig.get("noAdsFovMlt")) return ogAds;
      try {
        const ads: number[] = [];

        ads[render.getPlayerWeaponId(getLocalPlayer())] = 0;

        return ads;
      } catch {
        return genericAdsArray;
      }
    },
    set: (value) => {
      ogAds = value;
    },
  });

  const hookNHide = /^clouds_|lightcone_/;
  const wrapAdd = (value: RenderManager["add"]): RenderManager["add"] =>
    function (this: any, mesh, data) {
      value.call(this, mesh, data);
      if (typeof data === "object" && hookNHide.test(data.src)) {
        let visible = mesh.visible;
        Object.defineProperty(mesh, "visible", {
          get: () => (sketchConfig.get("hideClouds") &&
          !(sketchConfig.get("hideVisualsEndScreen") && isOnEndScreen())
            ? false
            : visible),
          set: (v) => (visible = v),
        });
      }
    };

  if (typeof (render as any).add === "function") {
    render.add = wrapAdd(render.add);
  } else {
    defineProperty(render, "add", {
      configurable: true,
      set(value: RenderManager["add"]) {
        delete (render as any).add;
        render.add = wrapAdd(value);
      },
    });
  }
}

// NOTE: game used to be captured with an Object.prototype "controls" accessor.
// Same failure mode as the "render" trap above -- see patches.game, which
// anchors on the Game constructor's this['isServer']/this['isClient'] pair.

let game: Game | undefined;

export function getGame() {
  if (!game) throw new Error("Too early");
  return game;
}

/**
 * When the result of the hook is false, inputs will be blocked
 */
export const inputHooks: ((inputs: number[]) => boolean | void)[] = [];

// in-game player, not menu player
let localPlayer: Player | undefined;

export function getLocalPlayer() {
  if (!localPlayer) throw new Error("Too early");
  return localPlayer;
}

export const onGameHooks: (() => void)[] = [];
export const onPlayerAddHooks: ((player: Player) => void)[] = [];

let sprayingFakeServer = false;

let ogCanSee: Game["canSee"] | undefined;

const hookAttach = Symbol();

const reportedHookErrors = new Set<string>();

// Per-frame hooks: log each distinct failure once instead of every frame.
function reportHookError(label: string, e: unknown) {
  if (!isDevelopment) return;
  const key = label + ":" + (e instanceof Error ? e.message : String(e));
  if (reportedHookErrors.has(key)) return;
  reportedHookErrors.add(key);
  console.error(`[sketch] ${label} failed:`, e);
}

function runHooks(label: string, hooks: Array<() => void>) {
  for (const hook of hooks) {
    try {
      hook();
    } catch (e) {
      reportHookError(label, e);
    }
  }
}

function doGameHooks() {
  if (isDevelopment) console.log("HOOK: setting up game hooks", Object.keys(getGame()));
  const game = getGame();

  for (const attach of game.attach) {
    if (!(hookAttach in attach)) {
      const { req } = attach;
      const hooked = (player: any, game: any) => {
        return (
          sketchConfig.get("skinHack") ||
          typeof req !== "function" ||
          req(player, game)
        );
      };
      attach.req =
        typeof req === "function" ? mirrorAttributes(hooked, req) : hooked;
      attach[hookAttach] = true;
    }
  }

  if (isDevelopment) console.log("HOOK: game.attach hooked", game.attach.length, "attachments");

  ogCanSee = game.canSee;

  // cansee determines whether to show nametags
  if (isDevelopment) console.log("HOOK: game.canSee hooked");
  game.canSee = mirrorAttributes(
    function (this: any, ...args: Parameters<Game["canSee"]>) {
      if (sketchConfig.get("newNametags")) return 1;
      if (sketchConfig.get("nametags")) return null;
      return ogCanSee!.call(this, ...args);
    } as typeof ogCanSee,
    ogCanSee!,
  );

  const { broadcast } = game;

  if (isDevelopment) console.log("HOOK: game.broadcast hooked");
  game.broadcast = mirrorAttributes(
    function (this: any, packet: any, ...data: any[]) {
      if (packet === "sp" && sprayingFakeServer && sketchConfig.get("skinHack"))
        game.addSpray(...data);
      else broadcast.call(this, packet, ...data);
    } as typeof broadcast,
    broadcast,
  );

  gameConfig = game.config;

  defineProperty(game, "config", {
    get() {
      return gameConfig;
    },
    set(config: Game["config"]) {
      gameConfig = config;

      let realThirdPerson = config.thirdPerson;

      defineProperty(config, "thirdPerson", {
        get() {
          return sketchConfig.get("thirdPerson") || realThirdPerson;
        },
        set(value) {
          realThirdPerson = value;
        },
      });
    },
  });

  const { add } = getGame().players;

  runHooks("onGameHooks", onGameHooks);

  if (isDevelopment) console.log("HOOK: game.players.add hooked");
  game.players.add = mirrorAttributes(
    function (this: any, ...args: Parameters<typeof add>) {
      const player = add.call(this, ...args);

      if (player.isYou) localPlayer = player;

      for (const hook of onPlayerAddHooks) hook(player);

      return player;
    } as typeof add,
    add,
  );

  const tmpInptsPush = game.controls.tmpInpts.push;

  /*
  Order of calls:

  tmpInpts.push()
  player.procInputs()
  io.send('q')
  */

  if (isDevelopment) console.log("HOOK: game.controls.tmpInpts.push hooked");
  game.controls.tmpInpts.push = mirrorAttributes(
    function (this: any, inputs: any) {
      if (localPlayer)
        for (const hook of inputHooks) {
          try {
            hook(inputs);
          } catch (e) {
            reportHookError("inputHook", e);
          }
        }
      return tmpInptsPush.call(this, inputs);
    } as typeof tmpInptsPush,
    tmpInptsPush,
  );

  const mapObjectsPush = game.map.manager.objects.push;

  if (isDevelopment) console.log("HOOK: game.map.manager.objects.push hooked");
  game.map.manager.objects.push = mirrorAttributes(
    function (this: any, obj: any) {
      let trans = obj.transparent;
      defineProperty(obj, "transparent", {
        get(this: MapObject) {
          if (sketchConfig.get("wallbangs") && checkingCanSee)
            return this.penetrable ? 1 : 0;
          return trans;
        },
        set(this: MapObject, value) {
          trans = value;
        },
      });

      return mapObjectsPush.call(this, obj);
    } as typeof mapObjectsPush,
    mapObjectsPush,
  );
}

let gameConfig: Game["config"] | undefined;

export function getGameConfig() {
  if (!gameConfig) throw new Error("Too early");
  return gameConfig;
}

// NOTE: showFPS used to be forced through an Object.prototype
// "bundleMedalFilters" setter trap. That could never install, because
// Object.prototype is already non-extensible by the time beforeGame runs, so it
// only ever logged a failure. SETTINGS is now captured directly via
// patches.settings and the accessor is installed in doSettingsHooks.

/**
 * player created while in the menu
 * basically local player but it never spawns
 * and it's not the localPlayer
 * menuPlayer can be undefined when the player isn't signed in
 */
let menuPlayer: Player | undefined;

export function getMenuPlayer() {
  return menuPlayer;
}

// hook helper func that returns the list of skins that the target plr has
// function helper(player, unkown)
// returns {ind:number,cnt:number}[]
// used for ui to list owned items

// patches.UISkins = [
//   /((\w+)\.isDev\?\w+:)(\2\?\2\.skins:\[\])/,
//   (match, crap, player, skinArray) => crap + `${dataArg}.uiSkins(${skinArray})`,
// ];

// force the loadout menu to render "owned" skins, even logged out
// so schizo..
// patches.ForceLoadout = [
//   /(\w+)&&(\(\w+\[\w+\.loadout\[0\]\]!=null)/,
//   (match, player, crap) => `(${dataArg}.skinHack||${player})&&${crap}`,
// ];

// now do customize...
// patches.Skins = [
//   /(\(\w+)\|\|(_.store\.skins)/,
//   (match, con1, con2) => `${con1}||${dataArg}.skinHack||${con2}`,
// ];

// NOW SKIN tone chicken bone
// (ee && ee.premiumT > 0 ? "<input class='skinColorItem
// patches.PremiumSkinColors = [
//   /(\((\w+)&&\2.premiumT>0)\?("<input class='skinColorItem)/g,
//   (match, con1, player, out1) => `${con1}||${dataArg}.skinHack?${out1}`,
// ];

// bypass premium check for skinz
//:3
// patches.PremiumSkins = [
//   /((\w+)&&\2.premiumT>0);(_\.isSandbox)/,
//   (match, condition, player, crap) =>
//     `${dataArg}.skinHack||${condition};` + crap,
// ];

// patches["𝓯𝓻𝓮𝓪𝓴𝔂 𝓼𝓹𝓻𝓪𝔂"] = [
//   /(\w+)\.isSandbox\?(\w+)\.players\.spray\((.*?)\):(\w+)\.send/g,
//   (match, gameVar, dumbGameVar, sprayArgs, ioVar) =>
//     `${gameVar}.isSandbox?${dumbGameVar}.players.spray(${sprayArgs}):${dataArg}.skinHack?${dataArg}.spraySemen(${sprayArgs}):${ioVar}.send`,
// ];

// game checks for premium on press and release
// patches["skin picker wheel"] = [
//   /sprayWheel\.isKey\(\w+\)&&\(\w+\.isSandbox\|\|/g,
//   (match) => match + `${dataArg}.skinHack||`,
// ];

let box: KrunkBox | undefined;

export function getBox() {
  if (!box) throw new Error("Too early");
  return box;
}

// https://convertcase.net/unicode-text-converter/

//
// patches["🦁𝓣𝓱𝓮 𝓛𝓲𝓸𝓷 𝓡𝓪𝓹𝓮𝓼 𝓽𝓱𝓮 𝓢𝓶𝓪𝓵𝓵 𝓓𝓸𝓰 𝓦𝓱𝓮𝓷 𝓘𝓽 𝓑𝓪𝓻𝓴𝓼"] = [
//   /if\((\w+)\.isSandbox\|\|(\w+)\.account&&\2\.account\.premiumT>0\)\{var (\w+)=/,
//   (match, gameVar, accVar, skinFreeVar) =>
//     `if(${dataArg}.skinHack||${gameVar}.isSandbox||${accVar}.account&&${accVar}.account.premiumT>0){var ${skinFreeVar}=${dataArg}.skinHack||`,
// ];

const fakeObj = function (this: any, a: any) {
  return Object.call(this, a);
};

const descs = Object.getOwnPropertyDescriptors(Object);

// descs.defineProperty.value = ((o: Player, k: string, a: PropertyDescriptor) => {
//   // console.log(o, k, a);
//   if (k === "isServer") {
//     const { get } = a;
//     a.get = function () {
//       return sprayingFakeServer || get!.call(this);
//     };
//   }

//   if (k === "inventory" && typeof o === "object" && o !== null && o.id === -1) {
//     console.log({a}, "got cll");
// debugger;
//     defineProperty(o, "init", {
//       configurable: true,
//       set: (init) => {
//         // console.trace("set init", init);
//         delete (o as any).init;
//         o.init = function (...args) {
//           const menuSig = [0, 0, 0, "preview", false];
//           if (menuSig.every((v, i) => args[i] === v)) {
//             // console.trace("IM THE MENU PLAYER");
//             menuPlayer = o;
//           }
//           return init.call(this, ...args);
//         };
//       },
//     });
//   }

//   return defineProperty(o, k, a);
// }) as any;

// console.log(descs);

const freeze = descs.freeze.value!;

descs.freeze.value = (o: any) => {
  if ("gameVersion" in o) {
    config = o;
  }
  return freeze(o);
};

const origPreventExt = descs.preventExtensions.value!;
descs.preventExtensions.value = (o: any) => {
  // Don't let game code lock down Object.prototype — we need it extensible for hooks
  try { if (o && o.constructor && o.constructor.prototype === o) return o; } catch {}
  return origPreventExt(o);
};

Object.defineProperties(fakeObj, descs);

/* javascript-obfuscator:enable */

export const hook = (
  src: string,
  ebox: KrunkBox,
  args: Record<string, any>,
): string => {
  box = ebox;

  for (const name in patches) {
    const patch = patches[name];
    let ran = false;
    src = src.replace(patch[0], (...args) => {
      ran = true;
      return patch[1](...args);
    });
    if (isDevelopment) console.log("[DEV] patching", name, "worked:", ran);
  }

  args[dataArg] = data;

  return src;
};

if (isDevelopment) {
  console.trace("[DEV]");

  Object.assign(getExposedWindow(), {
    getGame,
    getRender,
    getLocalPlayer,
    getMenuPlayer,
    getOverlay,
    getConfig,
    getGameConfig,
    getIO,
  });
}
