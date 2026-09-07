const BUILD_RE = /\/pkg\/loader-([A-Za-z0-9_-]+)\.(?:mjs|wasm)/
const BUILD_ATTR_RE = /build=([A-Za-z0-9_-]{3,})/

export function buildIdFrom(url: string): string | null {
  const m = BUILD_RE.exec(url)
  return m ? m[1] : null
}

// The stock loader is pulled in by a dynamic import(), so it never appears as a
// script[src] an observer could catch; read the id out of the markup instead.
export function detectBuildId(win: Window): string | null {
  const doc = win.document
  if (!doc) return null

  const tagged = doc.querySelectorAll("script[src], link[href]")
  for (let i = 0; i < tagged.length; i++) {
    const el = tagged[i]
    const id = buildIdFrom(
      el.getAttribute("src") || el.getAttribute("href") || ""
    )
    if (id) return id
  }

  const html = doc.documentElement ? doc.documentElement.innerHTML : ""
  const inline = BUILD_RE.exec(html)
  if (inline) return inline[1]

  const attr = BUILD_ATTR_RE.exec(html)
  return attr ? attr[1] : null
}
