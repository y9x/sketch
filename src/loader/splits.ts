// Hard ceiling only — never the expected count. The real split count is
// per-build and changes (8 on older builds, 10 on qJfFO/1QVCS); fetchSplits
// below self-calibrates by stopping at the short final split.
export const SPLIT_COUNT = 64

const ATTEMPTS = 3
const RETRY_DELAY_MS = 250

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A single failed split loses the whole payload, so each one gets its own
// bounded retry instead of failing the boot on one flaky response.
async function fetchSplit(
  url: string,
  fetchImpl: typeof fetch
): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt)
    try {
      const res = await fetchImpl(url, { credentials: "include" })
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${url} -> failed`)
}

// Returns true when a fetchSplit rejection looks like a genuine end-of-series
// (HTTP 404) rather than a network/auth failure we should surface.
function isEndOfSeries(error: unknown): boolean {
  return error instanceof Error && /-> HTTP 404\b/.test(error.message)
}

export async function fetchSplits(
  build: string,
  fetchImpl: typeof fetch
): Promise<Uint8Array> {
  // split-0 is always a full split; its length is the reference "full" size.
  const first = await fetchSplit(`/pkg/core.dat-${build}.split-0`, fetchImpl)
  const fullSize = first.length
  const parts: Uint8Array[] = [first]

  // Pull splits until one is SHORTER than split-0 (the runt final split) or a
  // 404 ends the series. The split count varies per build, so never assume it.
  for (let i = 1; i < SPLIT_COUNT; i++) {
    let part: Uint8Array
    try {
      part = await fetchSplit(`/pkg/core.dat-${build}.split-${i}`, fetchImpl)
    } catch (error) {
      if (isEndOfSeries(error)) break
      throw error
    }
    parts.push(part)
    if (part.length < fullSize) break
  }

  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
