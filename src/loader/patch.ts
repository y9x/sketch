import { diag, log } from "./log"
import { webcrack } from "webcrack"

export type SourcePatch = {
  name: string
  find: RegExp
  replace: string
}

// Names shown for other players arrive from the game server, so these two only
// affect client-side fallback paths (menu player list, demo chat playback).
// uiSmokeTest is the reliable proof the pipeline ran: Settings -> search "Ice".
export const DEFAULT_PATCHES: SourcePatch[] = [
  { name: "alphaSmokeTest", find: /Alpha/g, replace: "Meal" },
  { name: "bravoSmokeTest", find: /Bravo/g, replace: "Hood" },
  { name: "guestName", find: /Guest_/g, replace: "Noob_" },
  { name: "playerName", find: /Player_/g, replace: "Pro_" },
  {
    name: "devTest",
    find: /Local(?: |\\x20)User/g,
    replace: "Sketch User",
  },
]

const DEOBFUSCATED_PATCHES = new Set(["devTest"])

const IDENTIFIER = String.raw`[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*`
const LOCAL_USER_BRANCH = new RegExp(
  String.raw`(window\[(?:'isBotFTUE'|"isBotFTUE")\]\?${IDENTIFIER}\(0x[\da-f]+\):)${IDENTIFIER}\(0x[\da-f]+\)`,
  "giu"
)
function countMatches(source: string, pattern: RegExp): number {
  pattern.lastIndex = 0
  const count = source.match(pattern)?.length || 0
  pattern.lastIndex = 0
  return count
}

function replacePatch(source: string, patch: SourcePatch): string {
  if (!patch.find.global) {
    throw new Error(`patch "${patch.name}" must use a global regex`)
  }
  const hits = countMatches(source, patch.find)
  diag().patches[patch.name] = hits
  if (hits === 0) {
    log.warn(`patch "${patch.name}" matched 0 times (${patch.find})`)
    return source
  }
  log.info(`patch "${patch.name}": ${patch.find} -> ${patch.replace} x${hits}`)
  patch.find.lastIndex = 0
  return source.replace(patch.find, patch.replace)
}

function patchOriginalLocalUser(source: string): string | null {
  let hits = 0
  const patched = source.replace(LOCAL_USER_BRANCH, (_match, prefix: string) => {
    hits++
    return `${prefix}"Sketch User"`
  })
  if (hits === 0) return null
  if (hits !== 1)
    throw new Error(`original source has ${hits} local-player name branches`)
  diag().patches.devTest = 1
  log.info('patch "devTest": Local User decoder -> Sketch User x1')
  return patched
}

export async function applyPatches(
  source: string,
  patches: SourcePatch[] = DEFAULT_PATCHES,
  sandbox: (code: string) => Promise<unknown> = async (code) => (0, eval)(code)
): Promise<string> {
  let out = source
  const deferred = patches.filter((patch) => DEOBFUSCATED_PATCHES.has(patch.name))

  for (const patch of patches) {
    if (!DEOBFUSCATED_PATCHES.has(patch.name)) out = replacePatch(out, patch)
  }

  for (const patch of deferred) {
    if (countMatches(out, patch.find) > 0) {
      out = replacePatch(out, patch)
      continue
    }

    const patched = patchOriginalLocalUser(out)
    if (patched) {
      out = patched
      continue
    }

    log.info("deobfuscating source with webcrack")
    const result = await webcrack(out, {
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
    const revealed = countMatches(result.code, patch.find)
    throw new Error(
      `could not map ${patch.name} into original source (webcrack revealed ${revealed} matches)`
    )
  }
  return out
}
