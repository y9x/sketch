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
