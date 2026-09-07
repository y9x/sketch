import { log } from "./log"

const IDENT_RE = /\b[0-9a-f]{20}\b/g
const CALLBACK_RE = /'function'\s*==\s*typeof\s+([0-9a-f]{20})\s*&&\s*\1\s*\(/

// Renamed aliases are plain-ASCII 16-char identifiers, unlike the obfuscator's
// own names which are built from look-alike accented characters.
const ALIAS_RE = /\b([A-Za-z][A-Za-z0-9]{15})\s*\(/g
const MIN_ALIAS_CALLS = 3

// Globals the packer may hand in under a random name. When it renames one, the
// original identifier disappears from the source, which is how we pair them.
const RENAMEABLE = [
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "queueMicrotask",
]

export type GameParams = { token: string; callback: string }

export type RenamedAlias = { name: string; global: string }

export function recoverRenamed(
  source: string,
  win: Window & typeof globalThis
): RenamedAlias[] {
  const missing = RENAMEABLE.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(source)
  )
  if (missing.length === 0) return []

  const counts: Record<string, number> = {}
  ALIAS_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ALIAS_RE.exec(source)) !== null) {
    const name = match[1]
    // Escapes like \x20taylorInvSqrt live inside shader/HTML string literals.
    if (match.index > 0 && source.charAt(match.index - 1) === "\\") continue
    // A name the page already defines was never renamed away.
    if (name in win) continue
    counts[name] = (counts[name] || 0) + 1
  }

  const ranked = Object.keys(counts)
    .filter((name) => counts[name] >= MIN_ALIAS_CALLS)
    .sort((a, b) => counts[b] - counts[a])

  if (ranked.length < missing.length) {
    log.warn(
      `renamed globals: missing [${missing.join(", ")}] but only found [${ranked.join(", ")}]`
    )
  }

  const paired: RenamedAlias[] = []
  for (let i = 0; i < Math.min(missing.length, ranked.length); i++) {
    paired.push({ name: ranked[i], global: missing[i] })
  }
  return paired
}

// The game source is emitted as a function body over two per-build randomized
// identifiers; they are the only 20-hex tokens in it, so they can be read back.
export function recoverParams(source: string): GameParams {
  const seen: string[] = []
  IDENT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IDENT_RE.exec(source)) !== null) {
    if (seen.indexOf(m[0]) === -1) seen.push(m[0])
  }
  if (seen.length !== 2) {
    throw new Error(`expected 2 game params, found ${seen.length}`)
  }

  const cb = CALLBACK_RE.exec(source)
  if (cb) {
    const callback = cb[1]
    const token = seen[0] === callback ? seen[1] : seen[0]
    return { token, callback }
  }
  return { token: seen[0], callback: seen[1] }
}
