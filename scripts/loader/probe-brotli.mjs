import { readFileSync } from "node:fs"
import { BrotliDecStream, brotli_dec, initSync } from "brotli-dec-wasm/web"

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
const plain = new Uint8Array(ct.length)
for (let i = 0; i < ct.length; i++) plain[i] = ct[i] ^ ks[i]

console.log(`plain=${plain.length} full_decode=${brotli_dec(plain).length}`)

for (const n of [16, 32, 48, 96, 256, 1024, 8192]) {
  const s = new BrotliDecStream()
  try {
    const r = s.dec(plain.subarray(0, n), 1 << 16)
    const head = Buffer.from(r.buf.subarray(0, 24)).toString("latin1")
    console.log(
      `n=${n} code=${r.code} out=${r.buf.length} consumed=${r.input_offset} head=${JSON.stringify(head)}`
    )
  } catch (e) {
    console.log(`n=${n} THREW ${e}`)
  } finally {
    s.free()
  }
}

// Does reading buf after free() change the answer?
const s2 = new BrotliDecStream()
const r2 = s2.dec(plain.subarray(0, 8192), 1 << 16)
const lenBefore = r2.buf.length
s2.free()
console.log(`8192 out_before_free=${lenBefore} out_after_free=${r2.buf.length}`)
