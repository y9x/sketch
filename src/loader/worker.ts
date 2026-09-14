import { brotliDecompress } from "./brotli"
import { xorDecrypt } from "./keystreams"
import { applyPatches } from "./patch"
import { recoverParams } from "./params"

const LF = 0x0a
const MIN_SOURCE_BYTES = 5_000_000

type ProcessRequest = {
  type: "process"
  build: string
  ciphertext: ArrayBuffer
  keystream: ArrayBuffer
}

type PatchRequest = {
  type: "patch"
  source: string
  forceDeobfuscation?: boolean
}

type SandboxResult = {
  type: "sandbox-result"
  id: number
  value?: unknown
  error?: string
}

let sandboxId = 0
const sandboxRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

function sandbox(code: string): Promise<unknown> {
  const id = ++sandboxId
  return new Promise((resolve, reject) => {
    sandboxRequests.set(id, { resolve, reject })
    globalThis.postMessage({ type: "sandbox", id, code })
  })
}

function reassemble(body: Uint8Array): string {
  const full = new Uint8Array(body.length + 2)
  full[0] = LF
  full.set(body, 1)
  full[full.length - 1] = LF
  return new TextDecoder("utf-8").decode(full)
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

globalThis.onmessage = async (
  event: MessageEvent<ProcessRequest | PatchRequest | SandboxResult>
) => {
  if (event.data.type === "sandbox-result") {
    const request = sandboxRequests.get(event.data.id)
    if (!request) return
    sandboxRequests.delete(event.data.id)
    if (event.data.error) request.reject(new Error(event.data.error))
    else request.resolve(event.data.value)
    return
  }

  try {
    if (event.data.type === "patch") {
      const source = await applyPatches(
        event.data.source,
        undefined,
        sandbox,
        event.data.forceDeobfuscation,
      )
      globalThis.postMessage({ type: "patched", source })
      return
    }

    const { ciphertext, keystream } = event.data
    const decrypted = xorDecrypt(
      new Uint8Array(ciphertext),
      new Uint8Array(keystream)
    )
    const buildBytes = new TextEncoder().encode(event.data.build)
    const hashInput = new Uint8Array(buildBytes.length + decrypted.length)
    hashInput.set(buildBytes)
    hashInput.set(decrypted, buildBytes.length)
    const hash = hex(await crypto.subtle.digest("SHA-256", hashInput))
    const plaintext = brotliDecompress(decrypted)
    if (plaintext.length < MIN_SOURCE_BYTES) {
      throw new Error(`decoded source is only ${plaintext.length} bytes`)
    }

    const rawSource = reassemble(plaintext)
    globalThis.postMessage({
      type: "result",
      hash,
      rawSource,
      sourceBytes: plaintext.length,
      params: recoverParams(rawSource),
    })
  } catch (error) {
    globalThis.postMessage({
      type: "error",
      error: error instanceof Error ? error.stack || error.message : String(error),
    })
  }
}
