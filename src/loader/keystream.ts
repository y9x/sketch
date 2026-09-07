import keystreamB64 from "./keystream.bin"
import { decodeBase64 } from "./base64"

// The keystream is build-specific: core.dat from any other build will not decrypt.
export const KEYSTREAM_BUILD = "j5XbE"
export const KEYSTREAM_LENGTH = 1835652

let cached: Uint8Array | null = null

export function getKeystream(): Uint8Array {
  if (cached) return cached
  const out = decodeBase64(keystreamB64)
  if (out.length !== KEYSTREAM_LENGTH) {
    throw new Error(`keystream is ${out.length} bytes, expected ${KEYSTREAM_LENGTH}`)
  }
  cached = out
  return out
}
