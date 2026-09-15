import type { WasmReport } from "./signature"
import { LOADER_KEYS } from "./keys"

type Stage =
  | "init"
  | "build-detected"
  | "splits-fetched"
  | "token-fetched"
  | "wasm-scanned"
  | "decrypted"
  | "decompressed"
  | "patched"
  | "page-loaded"
  | "integrated"
  | "executing"
  | "done"
  | "failed"
  | "restored"

export type DeriveSummary = {
  segments: number
  dataBytes: number
  buildIds: string[]
  candidates: number
  probed: number
  hit: string | null
}

export type Diagnostics = {
  stage: Stage
  buildId: string | null
  blocked: string[]
  ciphertextBytes: number
  sourceBytes: number
  sourceChars: number
  params: string[] | null
  patches: Record<string, number>
  tokenLength: number
  wasm: WasmReport | null
  derive: DeriveSummary | null
  timings: Record<string, number>
  error: string | null
  log: string[]
}

const PREFIX = "[sketch-loader]"
const started = Date.now()

const diagnostics: Diagnostics = {
  stage: "init",
  buildId: null,
  blocked: [],
  ciphertextBytes: 0,
  sourceBytes: 0,
  sourceChars: 0,
  params: null,
  patches: {},
  tokenLength: 0,
  wasm: null,
  derive: null,
  timings: {},
  error: null,
  log: [],
}

// Exposed so a user can inspect what the loader did from the devtools console.
try {
  ;(globalThis as Record<string, unknown>)[LOADER_KEYS.diagnostics] = diagnostics
} catch {
  // Ignored: diagnostics are a convenience, not a requirement.
}

function emit(level: "log" | "warn" | "error", args: unknown[]): void {
  const ms = Date.now() - started
  const line = `+${ms}ms ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`
  diagnostics.log.push(line)
  try {
    console[level](PREFIX, ...args)
  } catch {
    // Ignored: the page may have replaced console.
  }
}

export const log = {
  info: (...args: unknown[]) => emit("log", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
}

export function setStage(stage: Stage): void {
  diagnostics.stage = stage
  diagnostics.timings[stage] = Date.now() - started
  log.info(`stage: ${stage}`)
}

export function diag(): Diagnostics {
  return diagnostics
}
