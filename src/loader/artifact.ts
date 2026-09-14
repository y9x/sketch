const API_URL = process.env.SKETCH_API_URL || ""

export async function fetchKeystreamArtifact(
  build: string,
  fetchImpl: typeof fetch
): Promise<Uint8Array> {
  if (!API_URL) throw new Error("KrunkBox API URL is not configured")
  if (!/^[A-Za-z0-9_-]+$/.test(build)) {
    throw new Error(`invalid loader build ${JSON.stringify(build)}`)
  }

  const url = new URL(`loader/${build}/keystream.bin`, API_URL)
  const response = await fetchImpl(url, { cache: "force-cache" })
  if (!response.ok) {
    throw new Error(`${url.pathname} -> HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length) throw new Error(`KrunkBox returned an empty keystream for ${build}`)

  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > 0 && bytes.length !== contentLength) {
    throw new Error(`KrunkBox keystream is ${bytes.length} bytes, expected ${contentLength}`)
  }
  return bytes
}