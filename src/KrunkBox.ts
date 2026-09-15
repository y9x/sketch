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
    while (true) {
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

      if (res?.status === 425) {
        await sleepError();
        continue;
      }

      if (!res?.ok) {
        await sleepError();
        continue;
      }

      const data = (await res.json()) as SketchVersion;

      return {
        ...data,
        // we have to resolve it
        updateURL: new URL(data.updateURL, apiURL).toString(),
      };
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
