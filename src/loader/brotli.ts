import wasmB64 from "./brotli.wasm"
import { BrotliDecStream, brotli_dec, initSync } from "brotli-dec-wasm/web"
import { decodeBase64 } from "./base64"

let ready = false

function ensureBrotli(): void {
  if (ready) return
  initSync({ module: decodeBase64(wasmB64) })
  ready = true
}

export function brotliDecompress(input: Uint8Array): Uint8Array {
  ensureBrotli()
  return brotli_dec(input)
}

// A prefix of a real stream decodes cleanly and asks for more; random bytes
// throw. Returns the output too, since parseability alone is a weak signal.
export function brotliPrefixDecode(input: Uint8Array): Uint8Array | null {
  ensureBrotli()
  try {
    const stream = new BrotliDecStream()
    try {
      return stream.dec(input, 1 << 16).buf
    } finally {
      stream.free()
    }
  } catch {
    return null
  }
}

export function isBrotliPrefix(input: Uint8Array): boolean {
  return brotliPrefixDecode(input) !== null
}
