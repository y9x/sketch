import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib"
import { chromium } from "/home/user/src/krunkbox/node_modules/patchright/index.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const proxy = process.env.SKETCH_LOADER_PROXY || "http://127.0.0.1:8888"
const timeout = Number(process.env.SKETCH_LOADER_TIMEOUT || 120_000)
const splitPattern = /\/pkg\/core\.dat-([A-Za-z0-9_-]+)\.split-(\d+)(?:\?|$)/
const preloadPath = "/home/user/src/krunkbox/dist/preload.js"

const splits = new Map()

function withTimeout(promise, milliseconds, message) {
  let timer
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

console.log(`[loader:update] launching stock Krunker through ${proxy}`)
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  proxy: { server: proxy },
})

try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const preloadSource = await readFile(preloadPath, "utf8")
  const initScript = `<script>(() => {
    const module = { exports: {} };
    const world = {
      module,
      exports: module.exports,
      require() { throw new Error("unsupported"); },
      __dirname: "",
      __filename: "",
      preload: ${JSON.stringify(preloadSource)},
    };
    new Function(...Object.keys(world), "eval(preload)")(...Object.values(world));
    window.__kruPreload = module.exports;
  })();</script>`

  await page.route("https://krunker.io/", async (route) => {
    const response = await route.fetch()
    let html = (await response.body()).toString("utf8")
    const head = html.indexOf("<head>")
    html =
      head === -1
        ? initScript + html
        : html.slice(0, head + 6) + initScript + html.slice(head + 6)
    await route.fulfill({ response, body: html })
  })

  page.on("response", async (response) => {
    const match = splitPattern.exec(response.url())
    if (!match) return
    try {
      const bytes = await response.body()
      splits.set(Number(match[2]), { build: match[1], bytes })
      console.log(
        `[loader:update] captured split ${match[2]} (${bytes.length} bytes)`
      )
    } catch (error) {
      console.warn(`[loader:update] failed to read ${response.url()}: ${error}`)
    }
  })

  await page.goto("https://krunker.io/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  })

  const preload = await page.evaluateHandle(
    () => window.__kruPreload,
    undefined,
    undefined,
    false
  )
  const extracted = await withTimeout(
    preload.evaluate(
      (loaderPreload) => loaderPreload.source(),
      undefined,
      undefined,
      false
    ),
    timeout,
    "timed out waiting for decoded source"
  )
  const source = extracted.source
  if (typeof source !== "string" || source.length <= 5_000_000) {
    throw new Error(`captured invalid source (${source?.length || 0} chars)`)
  }
  console.log(`[loader:update] captured source (${source.length} chars)`)

  const deadline = Date.now() + timeout
  while (splits.size < 8 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (splits.size !== 8) {
    throw new Error(`captured ${splits.size}/8 core.dat splits`)
  }

  const ordered = Array.from({ length: 8 }, (_unused, index) => splits.get(index))
  const build = ordered[0].build
  if (ordered.some((split) => !split || split.build !== build)) {
    throw new Error("captured incomplete or mixed-build splits")
  }

  const ciphertext = Buffer.concat(ordered.map((split) => split.bytes))
  const body = Buffer.from(source.slice(1, -1))
  const plaintext = brotliCompressSync(body, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_LGWIN]: 22,
    },
  })
  if (plaintext.length !== ciphertext.length) {
    throw new Error(
      `compressed source is ${plaintext.length} bytes, ciphertext is ${ciphertext.length}`
    )
  }

  const keystream = Buffer.alloc(ciphertext.length)
  for (let index = 0; index < ciphertext.length; index++) {
    keystream[index] = ciphertext[index] ^ plaintext[index]
  }
  if (!brotliDecompressSync(plaintext).equals(body)) {
    throw new Error("generated plaintext failed Brotli round-trip")
  }

  const keyPath = join(root, "src/loader/keystream.bin")
  const metadataPath = join(root, "src/loader/keystream.ts")
  const fixtureDir = join(root, "core-dat-files")
  const metadata = await readFile(metadataPath, "utf8")
  const updatedMetadata = metadata
    .replace(
      /export const KEYSTREAM_BUILD = "[^"]+"/,
      `export const KEYSTREAM_BUILD = "${build}"`
    )
    .replace(
      /export const KEYSTREAM_LENGTH = \d+/,
      `export const KEYSTREAM_LENGTH = ${keystream.length}`
    )

  await mkdir(fixtureDir, { recursive: true })
  await Promise.all(
    ordered.map((split, index) =>
      writeFile(join(fixtureDir, `core.dat-${build}.split-${index}`), split.bytes)
    )
  )
  await writeFile(keyPath, keystream)
  await writeFile(metadataPath, updatedMetadata)

  const hash = createHash("sha256").update(keystream).digest("hex")
  console.log(
    `[loader:update] updated build ${build}: ${keystream.length} bytes, sha256 ${hash}`
  )
} finally {
  await browser.close()
}
