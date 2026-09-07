import { diag, log } from "./log"

export type SourcePatch = {
  name: string
  find: string
  replace: string
}

// Names shown for other players arrive from the game server, so these two only
// affect client-side fallback paths (menu player list, demo chat playback).
// uiSmokeTest is the reliable proof the pipeline ran: Settings -> search "Ice".
export const DEFAULT_PATCHES: SourcePatch[] = [
  { name: "guestName", find: "Guest_", replace: "Noob_" },
  { name: "playerName", find: "Player_", replace: "Pro_" },
  {
    name: "uiSmokeTest",
    find: "Slippery\\x20Ice\\x20Effect",
    replace: "Sketch\\x20Ice\\x20Effect",
  },
]

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export function applyPatches(
  source: string,
  patches: SourcePatch[] = DEFAULT_PATCHES
): string {
  let out = source
  for (const patch of patches) {
    const hits = countOccurrences(out, patch.find)
    diag().patches[patch.name] = hits
    if (hits === 0) {
      log.warn(`patch "${patch.name}" matched 0 times (${patch.find})`)
      continue
    }
    out = out.split(patch.find).join(patch.replace)
    log.info(`patch "${patch.name}": ${patch.find} -> ${patch.replace} x${hits}`)
  }
  return out
}
