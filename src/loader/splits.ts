export const SPLIT_COUNT = 8

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

export async function fetchSplits(
  build: string,
  fetchImpl: typeof fetch
): Promise<Uint8Array> {
  const parts = await Promise.all(
    Array.from({ length: SPLIT_COUNT }, (_unused, i) =>
      fetchSplit(`/pkg/core.dat-${build}.split-${i}`, fetchImpl)
    )
  )

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
