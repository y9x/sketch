const CONFIGURED_API_URL = process.env.SKETCH_API_URL || ""
const PRODUCTION_API_URL = "https://kru.eli.gift/"
const ARTIFACT_ATTEMPTS = 30
const ARTIFACT_RETRY_MS = 2_500
const ARTIFACT_REQUEST_TIMEOUT_MS = 10_000

type LoaderArtifactManifest = {
  build: string
  byteLength: number
  keystreamSha256: string
  processedSourceSha256: string
  processedSourceBytes: number
}

type ArtifactResponse = {
  status: number
  bytes: Uint8Array
}

function apiUrls(): URL[] {
  const values = [CONFIGURED_API_URL, PRODUCTION_API_URL].filter(Boolean)
  return [...new Set(values)].map((value) => new URL(value))
}

function artifactUrl(apiUrl: URL, build: string, name: string): URL {
  if (!/^[A-Za-z0-9_-]+$/.test(build)) {
    throw new Error(`invalid loader build ${JSON.stringify(build)}`)
  }
  return new URL(`loader/${build}/${name}`, apiUrl)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")
}

function privilegedRequest(url: URL): Promise<ArtifactResponse> {
  if (typeof GM_xmlhttpRequest !== "function") {
    return fetch(url, { cache: "no-store" }).then(async (response) => ({
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
    }))
  }

  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "GET",
      url: url.toString(),
      responseType: "arraybuffer",
      timeout: ARTIFACT_REQUEST_TIMEOUT_MS,
      headers: { "cache-control": "no-cache" },
      onload(response) {
        resolve({
          status: response.status,
          bytes: new Uint8Array(response.response as ArrayBuffer),
        })
      },
      onerror(response) {
        reject(new Error(`${url.pathname} request failed: ${response.statusText}`))
      },
      ontimeout() {
        reject(new Error(`${url.pathname} request timed out`))
      },
    })
  })
}

async function fetchArtifactPair(
  apiUrl: URL,
  build: string,
  artifactName: "keystream.bin" | "source.js"
): Promise<{ manifest: LoaderArtifactManifest; bytes: Uint8Array }> {
  const manifestUrl = artifactUrl(apiUrl, build, "manifest.json")
  const artifact = artifactUrl(apiUrl, build, artifactName)
  const [manifestResponse, artifactResponse] = await Promise.all([
    privilegedRequest(manifestUrl),
    privilegedRequest(artifact),
  ])
  if (manifestResponse.status !== 200) {
    throw new Error(`${manifestUrl.pathname} -> HTTP ${manifestResponse.status}`)
  }
  if (artifactResponse.status !== 200) {
    throw new Error(`${artifact.pathname} -> HTTP ${artifactResponse.status}`)
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestResponse.bytes)
  ) as LoaderArtifactManifest
  if (manifest.build !== build) {
    throw new Error(`KrunkBox returned build ${manifest.build} for ${build}`)
  }
  return { manifest, bytes: artifactResponse.bytes }
}

async function retryArtifact<T>(
  build: string,
  load: (apiUrl: URL) => Promise<T>
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < ARTIFACT_ATTEMPTS; attempt++) {
    for (const apiUrl of apiUrls()) {
      try {
        return await load(apiUrl)
      } catch (error) {
        lastError = error
      }
    }
    if (attempt + 1 < ARTIFACT_ATTEMPTS) await sleep(ARTIFACT_RETRY_MS)
  }
  throw new Error(
    `KrunkBox did not publish loader build ${build}: ${String(lastError)}`
  )
}

export function fetchKeystreamArtifact(
  build: string,
  _fetchImpl: typeof fetch
): Promise<Uint8Array> {
  return retryArtifact(build, async (apiUrl) => {
    const { manifest, bytes } = await fetchArtifactPair(
      apiUrl,
      build,
      "keystream.bin"
    )
    if (bytes.length !== manifest.byteLength) {
      throw new Error(
        `KrunkBox keystream is ${bytes.length} bytes, expected ${manifest.byteLength}`
      )
    }
    if ((await sha256(bytes)) !== manifest.keystreamSha256) {
      throw new Error(`KrunkBox keystream hash mismatch for ${build}`)
    }
    return bytes
  })
}

export function fetchProcessedSourceArtifact(
  build: string,
  _fetchImpl: typeof fetch
): Promise<string> {
  return retryArtifact(build, async (apiUrl) => {
    const { manifest, bytes } = await fetchArtifactPair(
      apiUrl,
      build,
      "source.js"
    )
    if (bytes.length !== manifest.processedSourceBytes) {
      throw new Error(
        `KrunkBox processed source is ${bytes.length} bytes, expected ${manifest.processedSourceBytes}`
      )
    }
    if ((await sha256(bytes)) !== manifest.processedSourceSha256) {
      throw new Error(`KrunkBox processed source hash mismatch for ${build}`)
    }
    return new TextDecoder().decode(bytes)
  })
}