import { brotliDecompress } from "./brotli"
import { discoverKeystream, logDeriveReport } from "./derive"
import { pageWindow } from "./env"
import { executeGame } from "./execute"
import { knownBuilds, resolveKeystream, xorDecrypt } from "./keystreams"
import { diag, log, setStage } from "./log"
import { BYPASS_KEY, neutralize } from "./neutralize"
import { applyPatches } from "./patch"
import { fetchLoaderWasm, scanWasmBytes } from "./signature"
import { fetchSplits } from "./splits"
import { fetchToken } from "./token"

const LF = 0x0a

// The real source is ~10.7 MB; anything far short of that means the pipeline
// produced garbage even though brotli did not complain.
const MIN_SOURCE_BYTES = 5_000_000

// The encrypted payload omits the leading and trailing newline of the source.
function reassemble(body: Uint8Array): string {
  const full = new Uint8Array(body.length + 2)
  full[0] = LF
  full.set(body, 1)
  full[full.length - 1] = LF
  return new TextDecoder("utf-8").decode(full)
}

async function bootFromCoreDat(
  build: string,
  originalFetch: typeof fetch
): Promise<void> {
  const [ciphertext, token, binary] = await Promise.all([
    fetchSplits(build, originalFetch),
    fetchToken(originalFetch),
    // Advisory only: a scan failure must not sink a boot that would succeed.
    fetchLoaderWasm(build, originalFetch).catch((error) => {
      log.warn("loader wasm fetch failed:", String(error))
      return null
    }),
  ])
  diag().ciphertextBytes = ciphertext.length
  diag().tokenLength = token.length
  setStage("splits-fetched")
  setStage("token-fetched")
  log.info(`core.dat ${ciphertext.length} bytes, token ${token.length} chars`)

  if (binary) {
    diag().wasm = await scanWasmBytes(build, binary.url, binary.bytes).catch(
      (error) => {
        log.warn("wasm signature scan failed:", String(error))
        return null
      }
    )
  }
  setStage("wasm-scanned")

  let keystream = resolveKeystream(build)
  if (keystream) {
    log.info(`using bundled keystream for build ${build}`)
  } else if (binary) {
    log.warn(
      `no bundled keystream for build ${build} (have: ${knownBuilds().join(", ")}); scanning binary`
    )
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
  if (!keystream) {
    throw new Error(
      `no keystream for build ${build}: not bundled and not recoverable from the binary`
    )
  }

  const decrypted = xorDecrypt(ciphertext, keystream)
  setStage("decrypted")

  const plaintext = brotliDecompress(decrypted)
  diag().sourceBytes = plaintext.length
  setStage("decompressed")
  log.info(`decompressed to ${plaintext.length} bytes`)
  if (plaintext.length < MIN_SOURCE_BYTES) {
    throw new Error(`decoded source is only ${plaintext.length} bytes`)
  }

  const source = applyPatches(reassemble(plaintext))
  diag().sourceChars = source.length
  setStage("patched")

  // The stock loader runs the body from the window load handler, so executing
  // any earlier races the page's own <script src> libs.
  await whenLoaded(pageWindow())
  setStage("page-loaded")

  setStage("executing")
  executeGame(source, token)
}

function whenLoaded(win: Window): Promise<void> {
  if (win.document.readyState === "complete") return Promise.resolve()
  return new Promise((resolve) => {
    win.addEventListener("load", () => resolve(), { once: true })
  })
}

export async function boot(): Promise<void> {
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

    await bootFromCoreDat(build, originalFetch)
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
