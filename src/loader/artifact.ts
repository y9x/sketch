const API_URL = process.env.SKETCH_API_URL || ""

type ProcessedSourceManifest = {
  processedSourceSha256: string
  processedSourceBytes: number
}

function artifactUrl(build: string, name: string): URL {
  if (!API_URL) throw new Error("KrunkBox API URL is not configured")
  if (!/^[A-Za-z0-9_-]+$/.test(build)) {
    throw new Error(`invalid loader build ${JSON.stringify(build)}`)
  }
  return new URL(`loader/${build}/${name}`, API_URL)
}

export async function fetchKeystreamArtifact(
  build: string,
  fetchImpl: typeof fetch
): Promise<Uint8Array> {
  const url = artifactUrl(build, "keystream.bin")
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

export async function fetchProcessedSourceArtifact(
  build: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const manifestUrl = artifactUrl(build, "manifest.json")
  const sourceUrl = artifactUrl(build, "source.js")
  const [manifestResponse, sourceResponse] = await Promise.all([
    fetchImpl(manifestUrl, { cache: "force-cache" }),
    fetchImpl(sourceUrl, { cache: "force-cache" }),
  ])
  if (!manifestResponse.ok) {
    throw new Error(`${manifestUrl.pathname} -> HTTP ${manifestResponse.status}`)
  }
  if (!sourceResponse.ok) {
    throw new Error(`${sourceUrl.pathname} -> HTTP ${sourceResponse.status}`)
  }

  const manifest = (await manifestResponse.json()) as ProcessedSourceManifest
  const bytes = new Uint8Array(await sourceResponse.arrayBuffer())
  if (bytes.length !== manifest.processedSourceBytes) {
    throw new Error(
      `KrunkBox processed source is ${bytes.length} bytes, expected ${manifest.processedSourceBytes}`
    )
  }
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")
  if (hash !== manifest.processedSourceSha256) {
    throw new Error(`KrunkBox processed source hash mismatch for ${build}`)
  }
  return new TextDecoder().decode(bytes)
}