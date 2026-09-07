import { log } from "./log"

export type WasmTrait = {
  name: string
  present: boolean
  required: boolean
  detail?: string
}

export type WasmReport = {
  url: string
  bytes: number
  sha256: string | null
  typeCount: number
  funcCount: number
  decoderTypes: number[]
  traits: WasmTrait[]
  verdict: "verified" | "compatible" | "incompatible"
}

// sha256 of the loader wasm each bundled keystream was recovered from.
const KNOWN_FINGERPRINTS: Record<string, string> = {
  j5XbE: "234532b69011103e01c87f23040916b846962f839f3a5fcebf4ebf4325e98707",
}

const FUNC_TYPE = 0x60
const I32 = 0x7f
const SECTION_TYPE = 1
const SECTION_FUNCTION = 3

function hex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.substr(i * 2, 2), 16)
  }
  return out
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

// Crypto++ emits both constants little-endian into the data section, and
// neither survives a hash swap.
const SHA512_K0 = hex("22ae28d7982f8a42")
const SHA384_IV0 = hex("d89e05c15d9dbbcb")
// Absence of these is what pins the cipher to an HMAC keystream over AES/ChaCha.
const AES_SBOX = hex("637c777bf26b6fc5")
const CHACHA_SIGMA = ascii("expand 32-byte k")
const CRYPTOPP_SHA384 = ascii("N8CryptoPP6SHA384E")
const HMAC_NAME = ascii("HMAC")
const TEXT_DECODER = ascii("TextDecoder")

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const limit = haystack.length - needle.length
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

type Walk = {
  typeCount: number
  funcCount: number
  decoderTypes: number[]
}

// Minimal section walk: enough to read the type and function counts without
// pulling in a full wasm parser.
function walkSections(bytes: Uint8Array): Walk {
  const walk: Walk = { typeCount: 0, funcCount: 0, decoderTypes: [] }
  let p = 8

  const leb = (): number => {
    let result = 0
    let shift = 0
    let byte = 0
    do {
      byte = bytes[p++]
      result |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return result >>> 0
  }

  while (p < bytes.length) {
    const id = bytes[p++]
    const size = leb()
    const end = p + size

    if (id === SECTION_TYPE) {
      const count = leb()
      walk.typeCount = count
      for (let i = 0; i < count; i++) {
        if (bytes[p++] !== FUNC_TYPE) break
        const paramCount = leb()
        let allI32 = true
        for (let k = 0; k < paramCount; k++) {
          if (bytes[p++] !== I32) allI32 = false
        }
        const resultCount = leb()
        let singleI32 = resultCount === 1
        for (let k = 0; k < resultCount; k++) {
          if (bytes[p++] !== I32) singleI32 = false
        }
        // BrotliDecoderDecompressStream(state, *in_len, **in, *out_len, **out)
        if (allI32 && paramCount === 5 && singleI32) walk.decoderTypes.push(i)
      }
    } else if (id === SECTION_FUNCTION) {
      walk.funcCount = leb()
    }

    p = end
  }

  return walk
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const digest = await subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  } catch {
    return null
  }
}

export async function fetchLoaderWasm(
  build: string,
  fetchImpl: typeof fetch
): Promise<{ url: string; bytes: Uint8Array }> {
  // Must use the pre-interception fetch; neutralize() answers this URL with 204.
  const url = `/pkg/loader-${build}.wasm`
  const res = await fetchImpl(url, { credentials: "include" })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())

  const magicOk =
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  if (!magicOk) throw new Error(`${url} is not a wasm module`)

  return { url, bytes }
}

export async function scanLoaderWasm(
  build: string,
  fetchImpl: typeof fetch
): Promise<WasmReport> {
  const { url, bytes } = await fetchLoaderWasm(build, fetchImpl)
  return scanWasmBytes(build, url, bytes)
}

export async function scanWasmBytes(
  build: string,
  url: string,
  bytes: Uint8Array
): Promise<WasmReport> {
  const walk = walkSections(bytes)
  const sha256 = await sha256Hex(bytes)
  const expected = KNOWN_FINGERPRINTS[build]

  const traits: WasmTrait[] = [
    {
      name: "sha512Constants",
      required: true,
      present: indexOfBytes(bytes, SHA512_K0) !== -1,
    },
    {
      name: "sha384Iv",
      required: true,
      present: indexOfBytes(bytes, SHA384_IV0) !== -1,
    },
    {
      name: "decoderSignature",
      required: true,
      present: walk.decoderTypes.length > 0,
      detail: `types=[${walk.decoderTypes.join(",")}]`,
    },
    {
      name: "noAes",
      required: true,
      present: indexOfBytes(bytes, AES_SBOX) === -1,
    },
    {
      name: "noChaCha",
      required: true,
      present: indexOfBytes(bytes, CHACHA_SIGMA) === -1,
    },
    {
      name: "cryptoPpSha384",
      required: false,
      present: indexOfBytes(bytes, CRYPTOPP_SHA384) !== -1,
    },
    {
      name: "hmac",
      required: false,
      present: indexOfBytes(bytes, HMAC_NAME) !== -1,
    },
    {
      name: "textDecoder",
      required: false,
      present: indexOfBytes(bytes, TEXT_DECODER) !== -1,
    },
  ]

  const missing = traits.filter((t) => t.required && !t.present)
  const verdict: WasmReport["verdict"] =
    expected && sha256 === expected
      ? "verified"
      : missing.length === 0
        ? "compatible"
        : "incompatible"

  const report: WasmReport = {
    url,
    bytes: bytes.length,
    sha256,
    typeCount: walk.typeCount,
    funcCount: walk.funcCount,
    decoderTypes: walk.decoderTypes,
    traits,
    verdict,
  }

  const summary = traits
    .map((t) => `${t.present ? "+" : "-"}${t.name}${t.detail ? `(${t.detail})` : ""}`)
    .join(" ")
  log.info(
    `wasm scan: ${bytes.length} bytes funcs=${walk.funcCount} types=${walk.typeCount} sha256=${(sha256 ?? "unavailable").slice(0, 16)}`
  )
  log.info(`wasm traits: ${summary}`)

  if (verdict === "verified") {
    log.info(`wasm fingerprint matches the loader keystream ${build} came from`)
  } else if (verdict === "compatible") {
    log.warn(
      expected
        ? `wasm for ${build} changed (expected ${expected.slice(0, 16)}); keystream may be stale`
        : `no known fingerprint for ${build}; relying on structural traits only`
    )
  } else {
    log.error(
      `wasm no longer matches the expected cipher shape (missing: ${missing.map((t) => t.name).join(", ")})`
    )
  }

  return report
}
