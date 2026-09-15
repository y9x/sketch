export const LOADER_KEY_PREFIX = "sketch.loader"

export const LOADER_KEYS = {
  bypass: `${LOADER_KEY_PREFIX}.bypass`,
  cacheActive: `${LOADER_KEY_PREFIX}.cache.active`,
  forceCacheMiss: `${LOADER_KEY_PREFIX}.forceCacheMiss`,
  storageBridge: "__sketchLoaderStorage",
  diagnostics: "__sketchLoader",
} as const

const RAW_CACHE_PREFIX = `${LOADER_KEY_PREFIX}.cache.raw.v1`
const LEGACY_RAW_CACHE_PREFIX = `${LOADER_KEY_PREFIX}.source.raw-v1`

export const LEGACY_LOADER_KEYS = {
  forceCacheMiss: "FORCE_CACHE_MISS",
} as const

export function loaderCacheKey(build: string): string {
  return `${RAW_CACHE_PREFIX}.${build}`
}

export function isLoaderCacheKey(key: string): boolean {
  return (
    key.startsWith(`${LOADER_KEY_PREFIX}.cache.raw.`) ||
    key.startsWith(`${LOADER_KEY_PREFIX}.source.`)
  )
}

export function outdatedLoaderCacheKeys(
  keys: string[],
  currentBuild: string
): string[] {
  const currentKey = loaderCacheKey(currentBuild)
  return keys.filter((key) => isLoaderCacheKey(key) && key !== currentKey)
}