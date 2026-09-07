const TOKEN_URL = "https://matchmaker.krunker.io/generate-token"

export async function fetchToken(fetchImpl: typeof fetch): Promise<string> {
  // Cross-origin: sending credentials trips CORS on the matchmaker.
  const res = await fetchImpl(TOKEN_URL)
  if (!res.ok) throw new Error(`generate-token -> HTTP ${res.status}`)
  return (await res.text()).trim()
}
