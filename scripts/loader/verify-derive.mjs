import { readFileSync } from "node:fs"
import { isBrotliPrefix } from "../../src/loader/brotli.ts"
import {
  decodesToSource,
  discoverKeystream,
  extractBuildIds,
  parseDataSegments,
} from "../../src/loader/derive.ts"

const WASM = "/home/user/src/krunkbox/bin/loader/loader.wasm"
const KS = "/home/user/src/krunkbox/artifacts/KEYSTREAM.bin"
const SPLIT = (i) =>
  `/home/user/src/sketch/core-dat-files/core.dat-j5XbE.split-${i}`

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`
  )
}

const wasm = new Uint8Array(readFileSync(WASM))
const keystream = new Uint8Array(readFileSync(KS))
const parts = []
for (let i = 0; i < 8; i++) parts.push(new Uint8Array(readFileSync(SPLIT(i))))
const ciphertext = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
let at = 0
for (const p of parts) {
  ciphertext.set(p, at)
  at += p.length
}

const CONFIRM = 16384
console.log(
  `wasm=${wasm.length} keystream=${keystream.length} ciphertext=${ciphertext.length}`
)

function xorTruth(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = ciphertext[i] ^ keystream[i]
  return out
}

function xorRandom(n) {
  const junk = new Uint8Array(n)
  crypto.getRandomValues(junk)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = ciphertext[i] ^ junk[i]
  return out
}

console.log("\n-- stage 1: cheap 48B parse prefilter --")
check("truth passes 48B parse", isBrotliPrefix(xorTruth(48)), true)
let fp1 = 0
const T1 = 2000
for (let t = 0; t < T1; t++) if (isBrotliPrefix(xorRandom(48))) fp1++
console.log(
  `48B parse false positives: ${fp1}/${T1} (${((fp1 / T1) * 100).toFixed(1)}%) -- prefilter only`
)

console.log("\n-- stage 2: 16KB content check (real discriminator) --")
check("truth passes 16KB content check", decodesToSource(xorTruth(CONFIRM)), true)
let fp2 = 0
const T2 = 400
for (let t = 0; t < T2; t++) if (decodesToSource(xorRandom(CONFIRM))) fp2++
console.log(`16KB content false positives: ${fp2}/${T2}`)
check("16KB content check zero false positives", fp2, 0)

console.log("\n-- data section --")
const segments = parseDataSegments(wasm)
const dataBytes = segments.reduce((n, s) => n + s.bytes.length, 0)
const largest = segments.reduce((m, s) => Math.max(m, s.bytes.length), 0)
check("segment count", segments.length, 43)
console.log(`dataBytes=${dataBytes} largest=${largest}`)
console.log(`embedded build ids: ${JSON.stringify(extractBuildIds(wasm))}`)
check("keystream cannot fit in any segment", largest < keystream.length, true)

console.log("\n-- synthetic positive: keystream stored verbatim --")
function leb(n) {
  const out = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return out
}
const payload = [1, 0x00, 0x41, 0x00, 0x0b, ...leb(keystream.length)]
const body = new Uint8Array(payload.length + keystream.length)
body.set(payload, 0)
body.set(keystream, payload.length)
const sizeBytes = leb(body.length)
const fake = new Uint8Array(8 + 1 + sizeBytes.length + body.length)
fake.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], 0)
fake[8] = 11
fake.set(sizeBytes, 9)
fake.set(body, 9 + sizeBytes.length)

const hit = await discoverKeystream(fake, ciphertext)
check("synthetic hit kind", hit.find?.kind ?? "none", "raw")
let identical = hit.find != null
if (hit.find) {
  for (let i = 0; i < keystream.length; i++) {
    if (hit.find.keystream[i] !== keystream[i]) {
      identical = false
      break
    }
  }
}
check("synthetic keystream byte-identical", identical, true)

console.log("\n-- real binary --")
const started = Date.now()
const real = await discoverKeystream(wasm, ciphertext)
console.log(
  `segments=${real.segments} dataBytes=${real.dataBytes} candidates=${real.candidates} probed=${real.probed} elapsedMs=${Date.now() - started}`
)
console.log(
  `find=${real.find ? `${real.find.kind}@${real.find.offset}` : "null"}`
)
check("real binary yields no false hit", real.find, null)

console.log(
  `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
)
process.exit(failures === 0 ? 0 : 1)
