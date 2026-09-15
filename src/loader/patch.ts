import { log } from "./log"
import { webcrack } from "webcrack"

export type SourcePatch = {
  name: string
  find: RegExp
  replace: string
}

// Loader-native game string substitutions were only smoke tests. Sketch's
// actual integration patches are applied by filters.ts to KrunkBox source.
export const DEFAULT_PATCHES: SourcePatch[] = []

export async function applyPatches(
  source: string,
  _patches: SourcePatch[] = DEFAULT_PATCHES,
  sandbox: (code: string) => Promise<unknown> = async (code) => (0, eval)(code),
  forceDeobfuscation = false,
): Promise<string> {
  if (forceDeobfuscation) {
    log.info("sketch.loader.forceCacheMiss: running full webcrack pass")
    await webcrack(source, {
      jsx: false,
      unpack: false,
      deobfuscate: true,
      unminify: false,
      mangle: false,
      sandbox,
      onProgress(progress: number) {
        if (progress % 10 === 0) log.info(`webcrack: ${progress}%`)
      },
    })
  }
  return source
}
