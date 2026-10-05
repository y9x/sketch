import { apiURL, isDevelopment } from "./consts";
import { console } from "./crashout";
import { GM_fetch, sleep } from "./util";

/**
 * Sleep after a server error occurred
 */
async function sleepError() {
  // Disable the obfuscator to optimize away isDevelopment
  /* javascript-obfuscator:disable */
  if (isDevelopment) console.warn("Server error, trying again in 3s");
  /* javascript-obfuscator:enable */
  await sleep(3e3);
}

export interface SketchVersion {
  outdated: boolean;
  // if we should even tell the user to update
  // sometimes sketch just isn't updated
  sketchUpdated: boolean;
  latestVersion: string;
  updateURL: string;
}

export default class KrunkBox {
  static async sketchVersion(currentVersion: string, supportedGame: string) {
    // Never hang the loader on a version check. A persistently 425-ing or down
    // server must not freeze the page forever: give up after a bounded number of
    // attempts and throw. main()'s `finally` settles the integration with null,
    // so the loader proceeds with the unpatched (stock) source instead of a hang.
    const MAX_ATTEMPTS = 6;
    let lastStatus = 0;
    for (let attempt = 1; ; attempt++) {
      const res = await GM_fetch(new URL("sketchVersion", apiURL), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ currentVersion, supportedGame }),
      }).catch((err) => {
        if (isDevelopment) console.error("Bro", err);
      });

      if (res?.ok) {
        const data = (await res.json()) as SketchVersion;
        return {
          ...data,
          // we have to resolve it
          updateURL: new URL(data.updateURL, apiURL).toString(),
        };
      }

      lastStatus = res?.status ?? 0;
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(
          `sketchVersion unreachable after ${MAX_ATTEMPTS} attempts (last HTTP ${lastStatus}); continuing without integration`,
        );
      }
      await sleepError();
    }
  }
  async reportCC(data: string) {
    await GM_fetch(new URL("cc", apiURL), {
      method: "POST",
      body: data,
    }).catch((err) => {
      if (isDevelopment) console.error("CC report error:", err);
    });
  }
}
