// Exercises the shipped scanner against the real loader.wasm with a stubbed fetch.
import { readFileSync } from 'node:fs'
import { scanLoaderWasm } from '../../src/loader/signature.ts'

const wasm = readFileSync('/home/user/src/krunkbox/bin/loader/loader.wasm')

globalThis.fetch = async (url) => {
  console.log('fetched', url)
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  }
}

const report = await scanLoaderWasm('j5XbE', globalThis.fetch)
console.log(JSON.stringify(report, null, 2))
console.log('VERDICT', report.verdict)

// A build we have no fingerprint for must degrade to "compatible", not fail.
const unknown = await scanLoaderWasm('zzzzz', globalThis.fetch)
console.log('UNKNOWN_BUILD_VERDICT', unknown.verdict)

// A hash-swapped loader must be rejected outright.
const tampered = Buffer.from(wasm)
const ivAt = tampered.indexOf(Buffer.from('d89e05c15d9dbbcb', 'hex'))
tampered[ivAt] ^= 0xff
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength),
})
const bad = await scanLoaderWasm('j5XbE', globalThis.fetch)
console.log('TAMPERED_VERDICT', bad.verdict)
