import { readFileSync } from "node:fs"
import { BrotliDecStream, initSync } from "brotli-dec-wasm/web"

initSync({
  module: readFileSync(
    "/home/user/src/sketch/node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm"
  ),
})

const ks = new Uint8Array(readFileSync("/home/user/src/krunkbox/artifacts/KEYSTREAM.bin"))
const parts = []
for (let i = 0; i < 8; i++) {
  parts.push(
    new Uint8Array(
      readFileSync(`/home/user/src/sketch/core-dat-files/core.dat-j5XbE.split-${i}`)
    )
  )
}
const ct = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
let at = 0
for (const p of parts) {
  ct.set(p, at)
  at += p.length
}

function parses(input) {
  const s = new BrotliDecStream()
  try {
    s.dec(input, 1 << 16)
    return true
  } catch {
    return false
  } finally {
    s.free()
  }
}

function decoded(input) {
  const s = new BrotliDecStream()
  try {
    return s.dec(input, 1 << 16).buf.length
  } catch {
    return -1
  } finally {
    s.free()
  }
}

const TRIALS = 3000
console.log(`trials=${TRIALS} per length`)
for (const n of [48, 96, 192, 384, 768, 1536]) {
  const truth = new Uint8Array(n)
  for (let i = 0; i < n; i++) truth[i] = ct[i] ^ ks[i]
  let fp = 0
  const junk = new Uint8Array(n)
  const probe = new Uint8Array(n)
  for (let t = 0; t < TRIALS; t++) {
    crypto.getRandomValues(junk)
    for (let i = 0; i < n; i++) probe[i] = ct[i] ^ junk[i]
    if (parses(probe)) fp++
  }
  const blocks = Math.ceil(n / 48)
  console.log(
    `n=${String(n).padStart(4)} hmacBlocks=${String(blocks).padStart(2)} truthParses=${parses(truth)} truthOut=${decoded(truth)} fp=${fp}/${TRIALS} (${((fp / TRIALS) * 100).toFixed(2)}%)`
  )
}
