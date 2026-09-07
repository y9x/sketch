import { KEYSTREAM_BUILD, KEYSTREAM_LENGTH, getKeystream } from "./keystream"

export { KEYSTREAM_BUILD, KEYSTREAM_LENGTH }

// The keystream is static per build. Supporting a new build is a one-line
// addition here once its keystream has been recovered offline.
const BUNDLED: Record<string, () => Uint8Array> = {
  [KEYSTREAM_BUILD]: getKeystream,
}

export function resolveKeystream(build: string): Uint8Array | null {
  const load = BUNDLED[build]
  return load ? load() : null
}

export function knownBuilds(): string[] {
  return Object.keys(BUNDLED)
}

export function xorDecrypt(
  ciphertext: Uint8Array,
  keystream: Uint8Array
): Uint8Array {
  if (ciphertext.length !== keystream.length) {
    throw new Error(
      `core.dat is ${ciphertext.length} bytes, keystream is ${keystream.length}`
    )
  }
  const out = new Uint8Array(ciphertext.length)
  for (let i = 0; i < ciphertext.length; i++) {
    out[i] = ciphertext[i] ^ keystream[i]
  }
  return out
}
