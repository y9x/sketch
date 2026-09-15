import { console } from "./crashout";
import KrunkBox from "./KrunkBox";
import {
  isDevelopment,
  isKrunker,
  sketchVersion,
  supportedGame,
} from "./consts";
import { afterGame, hook, runBeforeGameOnce, onGameHooks } from "./filters";
import { setInjectValues } from "./dogehook";
import { boot } from "./loader";
import { fetchProcessedSourceArtifact } from "./loader/artifact";
import sketchConfig, { initSketchConfig } from "./sketchConfig";
import { initPlayerSpoofConfig } from "./playerSpoofConfig";
import { showUpdated, showFutile, panic } from "./anxiety";
import { sketchButton } from "./menu/createUI";
import "./cheats";

if (isKrunker) {
  main().catch((err) => {
    if (isDevelopment) console.error(err);
    if (sketchConfig.get("silentFail")) return;
    panic(err.stack);
  });
}

/**
 * Check the #hash in the URL
 * Perform operations on the config
 */
function checkHash() {
  const hash = location.hash;

  if (hash === "#showUpdates") {
    // set the config
    sketchConfig.delete("silentFail");

    // remove the hash
    history.replaceState(
      "",
      document.title,
      location.pathname + location.search,
    );
  }
}

declare function enterGame(): void;

declare global {
  var Howler: any;
}

function buildPrologue(injectArgs: Record<string, any>): string {
  const lines: string[] = [
    'var __si = (typeof __sketchInject !== "undefined" ? __sketchInject : (typeof top !== "undefined" && top.__sketchInject) || (typeof parent !== "undefined" && parent.__sketchInject) || (typeof window !== "undefined" && window.__sketchInject));',
  ];
  if (isDevelopment)
    lines.push(
      'try { console.log("[sketch] prologue: __si =", !!__si, "beforeGame:", typeof (__si && __si.beforeGame)); } catch(e) {}',
    );
  for (const key of Object.keys(injectArgs)) {
    lines.push(`var ${key} = __si[${JSON.stringify(key)}];`);
  }
  lines.push('if (__si && __si.beforeGame) __si.beforeGame();');
  return lines.join('\n') + '\n';
}

async function main() {
  let integrationSettled = false;
  let resolveBox!: (box: KrunkBox | null) => void;
  const boxReady = new Promise<KrunkBox | null>((resolve) => {
    resolveBox = resolve;
  });
  const settleIntegration = (box: KrunkBox | null) => {
    if (integrationSettled) return;
    integrationSettled = true;
    resolveBox(box);
  };
  const loader = boot({
    resolveSource: (_source, { build, fetchImpl }) =>
      fetchProcessedSourceArtifact(build, fetchImpl),
    transformSource: async (source) => {
      const krunkbox = await boxReady;
      if (!krunkbox) return source;
      const injectArgs: Record<string, any> = {};
      const patched = hook(source, krunkbox, injectArgs);
      setInjectValues({ ...injectArgs, beforeGame: runBeforeGameOnce });
      // parseWorker normalizes the randomized token identifier to WP_MMToken.
      // executeGame still passes the live token as the first wrapper argument.
      return "var WP_MMToken = arguments[0];\n" + buildPrologue(injectArgs) + patched;
    },
  });

  try {
    await initSketchConfig();
    await initPlayerSpoofConfig();

    checkHash();

    const version = await KrunkBox.sketchVersion(sketchVersion, supportedGame);

    if (version.outdated) {
      if (sketchConfig.get("silentFail")) return;
      return showUpdated(version);
    }

    if (!version.sketchUpdated) {
      if (sketchConfig.get("silentFail")) return;
      return showFutile(version);
    }

    settleIntegration(new KrunkBox());

    onGameHooks.push(() => {
      // Isolated so one failing hook can't stop the button from mounting.
      for (const ag of afterGame) {
        try {
          ag();
        } catch (e) {
          if (isDevelopment) console.error("[sketch] afterGame hook failed:", e);
        }
      }

      try {
        sketchButton();
      } catch (e) {
        if (isDevelopment) console.error("[sketch] sketchButton failed:", e);
      }

      setTimeout(() => {
        setInterval(() => {
          if (sketchConfig.get("autoSpawn")) enterGame();
        }, 100);
      }, 1e3);
    });

    await loader;
  } finally {
    // Update checks or silent failure must not leave
    // the new loader paused after it has already neutralized the stock loader.
    settleIntegration(null);
  }
}
