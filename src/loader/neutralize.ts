import { buildIdFrom, detectBuildId } from "./buildId"
import { pageWindow } from "./env"
import { diag, log } from "./log"
import { LOADER_KEYS } from "./keys"

export type Interception = {
  build: Promise<string>
  originalFetch: typeof fetch
  // Hands the page back to the stock loader for one reload.
  restore: () => void
}

// Set before falling back so the next load skips us entirely.
export const BYPASS_KEY = LOADER_KEYS.bypass

const DETECT_TIMEOUT_MS = 15_000
const DETECT_POLL_MS = 50

// Stops the stock wasm loader from booting and reports the build id it wanted.
export function neutralize(): Interception {
  const win = pageWindow()
  const originalFetch = win.fetch.bind(win)

  let settle: (id: string) => void = () => {}
  let fail: (error: Error) => void = () => {}
  let settled = false
  const build = new Promise<string>((resolve, reject) => {
    settle = (id: string) => {
      if (settled) return
      settled = true
      diag().buildId = id
      resolve(id)
    }
    fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
  })

  const note = (url: string): void => {
    if (diag().blocked.indexOf(url) === -1) diag().blocked.push(url)
    log.info("blocked stock loader request:", url)
  }

  // The loader chunk comes in through import(), which is not interceptable, so
  // the real choke point is the wasm fetch its Emscripten glue makes.
  win.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const id = buildIdFrom(url)
    if (id) {
      note(url)
      settle(id)
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return originalFetch(input as RequestInfo, init)
  }

  const blockNode = (node: Node): void => {
    const el = node as Element
    if (!el || typeof el.getAttribute !== "function") return
    const url = el.getAttribute("src") || el.getAttribute("href") || ""
    const id = buildIdFrom(url)
    if (!id) return
    if (el.tagName === "SCRIPT") {
      ;(el as HTMLScriptElement).type = "javascript/blocked"
    }
    el.remove()
    note(url)
    settle(id)
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(blockNode)
  })
  observer.observe(win.document, { childList: true, subtree: true })

  win.addEventListener(
    "vite:preloadError",
    (event) => event.preventDefault(),
    true
  )

  // The stock loader still runs and aborts on the empty wasm we feed it.
  win.addEventListener(
    "unhandledrejection",
    (event) => {
      const reason = String(event.reason?.message ?? event.reason ?? "")
      if (reason.includes("BufferSource argument is empty")) {
        event.preventDefault()
        log.info("suppressed expected stock loader abort")
      }
    },
    true
  )

  const immediate = detectBuildId(win)
  if (immediate) {
    log.info("build id from markup:", immediate)
    settle(immediate)
  }

  const deadline = Date.now() + DETECT_TIMEOUT_MS
  const poll = win.setInterval(() => {
    if (settled) {
      win.clearInterval(poll)
      return
    }
    const id = detectBuildId(win)
    if (id) {
      log.info("build id found while polling:", id)
      settle(id)
      win.clearInterval(poll)
      return
    }
    if (Date.now() > deadline) {
      win.clearInterval(poll)
      fail(new Error("timed out determining the krunker build id"))
    }
  }, DETECT_POLL_MS)

  const restore = (): void => {
    observer.disconnect()
    win.clearInterval(poll)
    win.fetch = originalFetch
    // The stock loader already aborted on the blocked wasm, so a reload is the
    // only reliable way to give it a clean run.
    try {
      win.sessionStorage.setItem(BYPASS_KEY, "1")
      log.warn("reloading so the stock loader can take over")
      debugger;
      win.location.reload()
    } catch (error) {
      log.error("could not reload for the stock loader:", String(error))
    }
  }

  return { build, originalFetch, restore }
}
