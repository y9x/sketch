import { brotliPrefixDecode, isBrotliPrefix } from "./brotli"
import { log } from "./log"

export type DataSegment = {
  index: number
  memoryOffset: number
  bytes: Uint8Array
}

export type KeystreamFind = {
  kind: "raw"
  keystream: Uint8Array
  segment: number
  offset: number
}

export type DeriveReport = {
  segments: number
  dataBytes: number
  buildIds: string[]
  candidates: number
  probed: number
  find: KeystreamFind | null
}

const SECTION_DATA = 11
const PROBE_BYTES = 48
// Brotli at lgwin22 emits nothing until ~8KB; truth yields 5236 bytes there.
const CONFIRM_BYTES = 8192
const MIN_DECODED = 16
// Minified source names identifiers with high-byte Latin-1 chars (~0.5 printable),
// so an ASCII ratio cannot separate it from noise; JS structure can.
const SOURCE_MARKERS = ["function", "var ", "return", "prototype", "window"]
const MIN_MARKERS = 2
const BUILD_ID_RE = /loader-([A-Za-z0-9_-]{4,12})\.(?:mjs|wasm)/g

type Reader = { at: number }

function leb(bytes: Uint8Array, r: Reader): number {
  let result = 0
  let shift = 0
  let byte = 0
  do {
    byte = bytes[r.at++]
    result |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  return result >>> 0
}

function sleb(bytes: Uint8Array, r: Reader): number {
  let result = 0
  let shift = 0
  let byte = 0
  do {
    byte = bytes[r.at++]
    result |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  if (shift < 32 && byte & 0x40) result |= -(1 << shift)
  return result
}

// Active segments carry an i32.const offset expression; passive ones carry none.
function readOffsetExpr(bytes: Uint8Array, r: Reader): number {
  let offset = 0
  if (bytes[r.at] === 0x41) {
    r.at++
    offset = sleb(bytes, r)
  }
  while (r.at < bytes.length && bytes[r.at] !== 0x0b) r.at++
  r.at++
  return offset
}

export function parseDataSegments(bytes: Uint8Array): DataSegment[] {
  const out: DataSegment[] = []
  const r: Reader = { at: 8 }

  while (r.at < bytes.length) {
    const id = bytes[r.at++]
    const size = leb(bytes, r)
    const end = r.at + size

    if (id === SECTION_DATA) {
      const count = leb(bytes, r)
      for (let i = 0; i < count && r.at < end; i++) {
        const flags = leb(bytes, r)
        if (flags === 0x02) leb(bytes, r)
        const memoryOffset = flags === 0x01 ? 0 : readOffsetExpr(bytes, r)
        const length = leb(bytes, r)
        out.push({
          index: i,
          memoryOffset,
          bytes: bytes.subarray(r.at, r.at + length),
        })
        r.at += length
      }
    }

    r.at = end
  }

  return out
}

// Brotli alone accepts ~13% of random keys on a short probe; requiring the
// output to read as source text is what makes the oracle worth trusting.
export function decodesToSource(input: Uint8Array): boolean {
  const decoded = brotliPrefixDecode(input)
  if (!decoded || decoded.length < MIN_DECODED) return false
  let text = ""
  for (let i = 0; i < decoded.length; i++) {
    text += String.fromCharCode(decoded[i])
  }
  let hits = 0
  for (const marker of SOURCE_MARKERS) {
    if (text.includes(marker)) hits++
  }
  return hits >= MIN_MARKERS
}

export function extractBuildIds(bytes: Uint8Array): string[] {
  let text = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    text += b >= 32 && b < 127 ? String.fromCharCode(b) : "\u0000"
  }
  const found: string[] = []
  BUILD_ID_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BUILD_ID_RE.exec(text)) !== null) {
    if (found.indexOf(m[1]) === -1) found.push(m[1])
  }
  return found
}

function xorInto(
  out: Uint8Array,
  ciphertext: Uint8Array,
  keystream: Uint8Array,
  length: number
): void {
  for (let i = 0; i < length; i++) out[i] = ciphertext[i] ^ keystream[i]
}

// Scans the loader binary for a keystream stored verbatim. Every candidate is
// confirmed by decrypting real ciphertext, so a hit is not a guess.
export function discoverKeystream(
  wasm: Uint8Array,
  ciphertext: Uint8Array
): DeriveReport {
  const segments = parseDataSegments(wasm)
  const dataBytes = segments.reduce((sum, s) => sum + s.bytes.length, 0)
  const buildIds = extractBuildIds(wasm)
  const report: DeriveReport = {
    segments: segments.length,
    dataBytes,
    buildIds,
    candidates: 0,
    probed: 0,
    find: null,
  }

  const probe = new Uint8Array(PROBE_BYTES)
  const confirmLength = Math.min(CONFIRM_BYTES, ciphertext.length)

  // A segment long enough to cover core.dat would be the keystream verbatim.
  for (const segment of segments) {
    if (segment.bytes.length < ciphertext.length) continue
    report.candidates++
    xorInto(probe, ciphertext, segment.bytes, PROBE_BYTES)
    report.probed++
    if (!isBrotliPrefix(probe)) continue
    const confirm = new Uint8Array(confirmLength)
    xorInto(confirm, ciphertext, segment.bytes, confirmLength)
    if (!decodesToSource(confirm)) continue
    report.find = {
      kind: "raw",
      keystream: segment.bytes.subarray(0, ciphertext.length),
      segment: segment.index,
      offset: segment.memoryOffset,
    }
    return report
  }

  return report
}

export function logDeriveReport(report: DeriveReport): void {
  log.info(
    `wasm derive: segments=${report.segments} dataBytes=${report.dataBytes} candidates=${report.candidates} probes=${report.probed}`
  )
  if (report.buildIds.length) {
    log.info(`wasm embedded build ids: ${report.buildIds.join(", ")}`)
  }
  if (report.find) {
    const f = report.find
    log.info(
      `wasm derive HIT: ${f.kind} segment=${f.segment} offset=${f.offset}`
    )
  } else {
    log.info("wasm derive: no keystream recoverable from the binary")
  }
}
