declare const unsafeWindow: (Window & typeof globalThis) | undefined

// Tampermonkey sandboxes `window` whenever the script declares grants, so hooks
// installed on it never reach the page. Everything must target the page realm.
export function pageWindow(): Window & typeof globalThis {
  try {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow
  } catch {
    // Ignored: fall back to the sandbox window.
  }
  return window as Window & typeof globalThis
}
