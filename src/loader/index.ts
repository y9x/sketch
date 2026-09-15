import { discoverKeystream, logDeriveReport } from "./derive"
import { fetchKeystreamArtifact } from "./artifact"
import { pageWindow } from "./env"
import { type ExecutionMetadata, executeGame } from "./execute"
import {
  LEGACY_LOADER_KEYS,
  LOADER_KEYS,
  loaderCacheKey,
  outdatedLoaderCacheKeys,
} from "./keys"
import { diag, log, setStage } from "./log"
import { BYPASS_KEY, neutralize } from "./neutralize"
import { type GameParams, recoverRenamed } from "./params"
import { fetchLoaderWasm, scanWasmBytes } from "./signature"
import { fetchSplits } from "./splits"
import { fetchToken } from "./token"

declare const __LOADER_WORKER_SOURCE__: string

type CachedGame = {
  build: string
  hash: string
  rawSource: string
  sourceBytes: number
  metadata: ExecutionMetadata
}

type WorkerResult = {
  type: "result"
  hash: string
  rawSource: string
  sourceBytes: number
  params: GameParams
}

type WorkerPatched = { type: "patched"; source: string }

type WorkerError = { type: "error"; error: string }
type WorkerSandbox = { type: "sandbox"; id: number; code: string }

type StorageBridge = {
  get?: <T>(key: string, fallback: T) => T | Promise<T>
  set?: (key: string, value: unknown) => void | Promise<void>
  delete?: (key: string) => void | Promise<void>
  list?: () => string[] | Promise<string[]>
}

export type LoaderTransformContext = {
  build: string
  metadata: ExecutionMetadata
  fetchImpl: typeof fetch
}

export type LoaderOptions = {
  resolveSource?: (
    source: string,
    context: LoaderTransformContext
  ) => string | Promise<string>
  transformSource?: (
    source: string,
    context: LoaderTransformContext
  ) => string | Promise<string>
}

function storageBridge(): StorageBridge | undefined {
  return (
    globalThis as typeof globalThis & {
      __sketchLoaderStorage?: StorageBridge
    }
  )[LOADER_KEYS.storageBridge]
}

function evaluateSandbox(code: string): unknown {
  const frame = document.createElement("iframe")
  frame.style.display = "none"
  document.documentElement.appendChild(frame)
  try {
    return (frame.contentWindow as typeof globalThis | null)?.eval(code)
  } finally {
    frame.remove()
  }
}

function workerMessage<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<T | WorkerError | WorkerSandbox>) => {
      if ((event.data as WorkerSandbox).type === "sandbox") {
        const request = event.data as WorkerSandbox
        try {
          worker.postMessage({
            type: "sandbox-result",
            id: request.id,
            value: evaluateSandbox(request.code),
          })
        } catch (error) {
          worker.postMessage({
            type: "sandbox-result",
            id: request.id,
            error: error instanceof Error ? error.stack || error.message : String(error),
          })
        }
        return
      }
      if ((event.data as WorkerError).type === "error") {
        reject(new Error((event.data as WorkerError).error))
      } else {
        resolve(event.data as T)
      }
    }
    worker.onerror = (event) => reject(new Error(event.message))
  })
}

async function storageGet<T>(key: string, fallback: T): Promise<T> {
  const bridge = storageBridge()
  if (bridge?.get) return bridge.get(key, fallback)
  if (typeof GM_getValue === "function") return GM_getValue<T>(key, fallback)
  throw new Error("Tampermonkey storage API unavailable; reinstall the DEV userscript")
}

async function storageSet(key: string, value: unknown): Promise<void> {
  const bridge = storageBridge()
  if (bridge?.set) {
    await bridge.set(key, value)
    return
  }
  if (typeof GM_setValue === "function") {
    GM_setValue(key, value)
    return
  }
  throw new Error("Tampermonkey storage API unavailable; reinstall the DEV userscript")
}

async function storageDelete(key: string): Promise<void> {
  const bridge = storageBridge()
  if (bridge?.delete) {
    await bridge.delete(key)
    return
  }
  if (typeof GM_deleteValue === "function") {
    GM_deleteValue(key)
  }
}

async function storageList(): Promise<string[]> {
  const bridge = storageBridge()
  if (bridge?.list) return bridge.list()
  if (typeof GM_listValues === "function") return GM_listValues()
  if (typeof GM !== "undefined" && typeof GM.listValues === "function") {
    return GM.listValues()
  }
  throw new Error("Tampermonkey storage listing API unavailable")
}

async function clearOutdatedBuildData(build: string): Promise<void> {
  const currentKey = loaderCacheKey(build)
  try {
    const keys = await storageList()
    const staleKeys = outdatedLoaderCacheKeys(keys, build)
    const activeKey = await storageGet<string | null>(
      LOADER_KEYS.cacheActive,
      null
    )
    await Promise.all(staleKeys.map(storageDelete))
    if (activeKey !== null && activeKey !== currentKey) {
      await storageDelete(LOADER_KEYS.cacheActive)
    }
    if (staleKeys.length) {
      log.info(`cleared ${staleKeys.length} stale loader cache entries`)
    }
  } catch (error) {
    log.warn("stale loader cache cleanup failed:", String(error))
  }
}

async function readCachedGame(build: string): Promise<CachedGame | null> {
  try {
    const cached = await storageGet<CachedGame | null>(loaderCacheKey(build), null)
    if (
      cached?.build === build &&
      typeof cached.hash === "string" &&
      cached.hash.length === 64 &&
      typeof cached.rawSource === "string" &&
      cached.rawSource.length > 5_000_000 &&
      cached.metadata?.params?.token &&
      cached.metadata.params.callback &&
      Array.isArray(cached.metadata.renamed)
    ) {
      log.info(`raw source cache hit: build ${build}`)
      return cached
    }
  } catch (error) {
    log.warn("raw source cache read failed:", String(error))
  }
  log.info(`raw source cache miss: build ${build}`)
  return null
}

async function writeCachedGame(cached: CachedGame): Promise<void> {
  const key = loaderCacheKey(cached.build)
  try {
    const previous = await storageGet<string | null>(LOADER_KEYS.cacheActive, null)
    await storageSet(key, cached)
    await storageSet(LOADER_KEYS.cacheActive, key)
    if (previous && previous !== key) await storageDelete(previous)
    log.info(
      `raw source cached: build ${cached.build}, hash ${cached.hash.slice(0, 16)}`
    )
  } catch (error) {
    log.warn("raw source cache write failed:", String(error))
  }
}

async function processSource(
  build: string,
  ciphertext: Uint8Array,
  keystream: Uint8Array
): Promise<WorkerResult> {
  const url = URL.createObjectURL(
    new Blob([__LOADER_WORKER_SOURCE__], { type: "text/javascript" })
  )
  const worker = new Worker(url)

  try {
    const ciphertextBuffer = ciphertext.slice().buffer
    const keystreamBuffer = keystream.slice().buffer
    const resultPromise = workerMessage<WorkerResult>(worker)
    worker.postMessage(
      {
        type: "process",
        build,
        ciphertext: ciphertextBuffer,
        keystream: keystreamBuffer,
      },
      [ciphertextBuffer, keystreamBuffer]
    )
    return await resultPromise
  } finally {
    worker.terminate()
    URL.revokeObjectURL(url)
  }
}

async function patchSource(
  source: string,
  forceDeobfuscation = false
): Promise<string> {
  const url = URL.createObjectURL(
    new Blob([__LOADER_WORKER_SOURCE__], { type: "text/javascript" })
  )
  const worker = new Worker(url)
  try {
    const resultPromise = workerMessage<WorkerPatched>(worker)
    worker.postMessage({ type: "patch", source, forceDeobfuscation })
    return (await resultPromise).source
  } finally {
    worker.terminate()
    URL.revokeObjectURL(url)
  }
}

async function bootFromCoreDat(
  build: string,
  originalFetch: typeof fetch,
  options: LoaderOptions
): Promise<void> {
  const localStorage = pageWindow().localStorage
  const legacyForceCacheMiss = localStorage.getItem(
    LEGACY_LOADER_KEYS.forceCacheMiss
  )
  if (legacyForceCacheMiss !== null) {
    if (legacyForceCacheMiss) {
      localStorage.setItem(LOADER_KEYS.forceCacheMiss, "1")
    }
    localStorage.removeItem(LEGACY_LOADER_KEYS.forceCacheMiss)
  }
  const forceCacheMiss =
    localStorage.getItem(LOADER_KEYS.forceCacheMiss) === "1" ||
    Boolean(legacyForceCacheMiss)
  if (forceCacheMiss) {
    log.warn(
      `${LOADER_KEYS.forceCacheMiss} enabled: bypassing raw cache and forcing webcrack`
    )
  }
  const cached = forceCacheMiss ? null : await readCachedGame(build)
  if (cached) {
    const token = await fetchToken(originalFetch)
    let source = cached.rawSource
    if (options.resolveSource) {
      source = await options.resolveSource(source, {
        build,
        metadata: cached.metadata,
        fetchImpl: originalFetch,
      })
      log.info(`using processed KrunkBox source for build ${build}`)
    }
    if (!options.resolveSource) source = await patchSource(source)
    diag().tokenLength = token.length
    diag().sourceBytes = cached.sourceBytes
    diag().sourceChars = source.length
    setStage("token-fetched")
    setStage("patched")
    await executeWhenReady(
      source,
      token,
      cached.metadata,
      build,
      options,
      originalFetch,
    )
    return
  }

  const [ciphertext, token, artifact] = await Promise.all([
    fetchSplits(build, originalFetch),
    fetchToken(originalFetch),
    fetchKeystreamArtifact(build, originalFetch).catch((error) => {
      log.warn("KrunkBox keystream fetch failed; falling back to binary scan:", String(error))
      return null
    }),
  ])
  diag().ciphertextBytes = ciphertext.length
  diag().tokenLength = token.length
  setStage("splits-fetched")
  setStage("token-fetched")
  log.info(`core.dat ${ciphertext.length} bytes, token ${token.length} chars`)

  let keystream = artifact
  if (keystream) {
    log.info(`using KrunkBox keystream for build ${build}`)
  } else {
    const binary = await fetchLoaderWasm(build, originalFetch).catch((error) => {
      log.warn("loader wasm fetch failed:", String(error))
      return null
    })
    if (binary) {
      diag().wasm = await scanWasmBytes(build, binary.url, binary.bytes).catch(
        (error) => {
          log.warn("wasm signature scan failed:", String(error))
          return null
        }
      )
      setStage("wasm-scanned")
    const report = discoverKeystream(binary.bytes, ciphertext)
    diag().derive = {
      segments: report.segments,
      dataBytes: report.dataBytes,
      buildIds: report.buildIds,
      candidates: report.candidates,
      probed: report.probed,
      hit: report.find ? `${report.find.kind}@${report.find.offset}` : null,
    }
    logDeriveReport(report)
    if (report.find) keystream = report.find.keystream
    }
  }
  if (!keystream) {
    throw new Error(
      `no keystream for build ${build}: unavailable from KrunkBox and not recoverable from the binary`
    )
  }

  const processed = await processSource(build, ciphertext, keystream)
  const rawSource = processed.rawSource
  diag().sourceBytes = processed.sourceBytes
  setStage("decrypted")
  setStage("decompressed")
  log.info(`decompressed to ${processed.sourceBytes} bytes in worker`)
  diag().sourceChars = rawSource.length

  const metadata: ExecutionMetadata = {
    params: processed.params,
    renamed: recoverRenamed(rawSource, pageWindow()),
  }
  await writeCachedGame({
    build,
    hash: processed.hash,
    rawSource,
    sourceBytes: processed.sourceBytes,
    metadata,
  })

  let source = rawSource
  if (options.resolveSource) {
    source = await options.resolveSource(source, {
      build,
      metadata,
      fetchImpl: originalFetch,
    })
    log.info(`using processed KrunkBox source for build ${build}`)
  }
  // KrunkBox source is already webcracked; force-cache-miss should only force
  // the expensive deobfuscation oracle when standalone mode still uses raw source.
  if (!options.resolveSource) source = await patchSource(source, forceCacheMiss)
  diag().sourceChars = source.length
  setStage("patched")
  await executeWhenReady(source, token, metadata, build, options, originalFetch)
}

async function executeWhenReady(
  source: string,
  token: string,
  metadata: ExecutionMetadata,
  build: string,
  options: LoaderOptions,
  originalFetch: typeof fetch,
): Promise<void> {
  // The stock loader runs the body from the window load handler, so executing
  // any earlier races the page's own <script src> libs.
  await whenLoaded(pageWindow())
  setStage("page-loaded")

  if (options.transformSource) {
    source = await options.transformSource(source, {
      build,
      metadata,
      fetchImpl: originalFetch,
    })
    diag().sourceChars = source.length
    setStage("integrated")
  }

  setStage("executing")
  executeGame(source, token, metadata)
}

function whenLoaded(win: Window): Promise<void> {
  if (win.document.readyState === "complete") return Promise.resolve()
  return new Promise((resolve) => {
    win.addEventListener("load", () => resolve(), { once: true })
  })
}

export async function boot(options: LoaderOptions = {}): Promise<void> {
  const win = pageWindow()

  try {
    if (win.sessionStorage.getItem(BYPASS_KEY)) {
      win.sessionStorage.removeItem(BYPASS_KEY)
      log.warn("bypass flag set, leaving this load to the stock loader")
      return
    }
  } catch {
    // Ignored: no sessionStorage just means no bypass.
  }

  setStage("init")
  log.info(`booting on ${win.location.href}`)

  const { build: buildPromise, originalFetch, restore } = neutralize()

  try {
    const build = await buildPromise
    setStage("build-detected")
    log.info(`krunker build: ${build}`)

    await clearOutdatedBuildData(build)
    await bootFromCoreDat(build, originalFetch, options)
    setStage("done")
    log.info("game booted from core.dat, no wasm loader involved")
  } catch (error) {
    // A broken build-in-a-box is worse than vanilla Krunker, so hand control
    // back to the stock wasm loader instead of leaving a dead page.
    diag().error = String(error)
    setStage("failed")
    log.error("core.dat boot failed:", String(error))
    setStage("restored")
    restore()
  }
}
