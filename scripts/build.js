import http from "node:http";
import { obfuscate } from "./obfuscate.js";
import { expand } from "dotenv-expand";
import { config } from "dotenv-flow";
import { build, context } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import send from "@fastify/send";
import parseUrl from "parseurl";
import { userscriptMetadataGenerator } from "userscript-metadata-generator";

const isDevelopment = process.argv.includes("--dev");
const isDebug = isDevelopment; // process.argv.includes("--debug");

process.env.NODE_ENV = isDevelopment ? "development" : "production";

expand(config());

const root = new URL("../", import.meta.url);
const fromRoot = (p) => fileURLToPath(new URL(p, root));

/**
 * @type {import("../meta/sketch.json")}
 */
const sketchMeta = JSON.parse(
  await readFile(new URL("meta/sketch.json", root), "utf-8")
);

/**
 * @type {import("../meta/loader.dev.json")}
 */
let loaderDevMeta = {};
try {
  loaderDevMeta = JSON.parse(
    await readFile(new URL("meta/loader.dev.json", root), "utf-8")
  );
} catch {}

/**
 * @type {import("../meta/loader.json")}
 */
let loaderMeta = {};
try {
  loaderMeta = JSON.parse(
    await readFile(new URL("meta/loader.json", root), "utf-8")
  );
} catch {}

/**
 * @type {import("../meta/sketch.dev.json")}
 */
const sketchDevMeta = JSON.parse(
  await readFile(new URL("meta/sketch.dev.json", root), "utf-8")
);

/**
 * @type {import("../package.json")}
 */
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf-8"));

process.env.SKETCH_VERSION = pkg.version;

const envKeys = [
  "NODE_ENV",
  ...Object.keys(process.env).filter((key) => key.startsWith("SKETCH_")),
];

const envReplacements = {
  ...envKeys.reduce((r, key) => {
    if (key in process.env)
      r[`process.env.${key}`] = JSON.stringify(process.env[key]);
    return r;
  }, {}),
};

console.log(envReplacements);

const mainOut = fromRoot("dist/sketch.user.js");
const loaderOut = fromRoot("dist/loader.user.js");
const loaderBrowser = {
  alias: { path: "path-browserify", "node:path": "path-browserify" },
  external: ["isolated-vm", "node:fs/promises"],
  loader: { ".bin": "base64", ".wasm": "base64" },
  define: { ...envReplacements, process: '{"env":{}}' },
  bundle: true,
  platform: "browser",
};

const loaderWorker = await build({
  ...loaderBrowser,
  entryPoints: [fromRoot("src/loader/worker.ts")],
  format: "iife",
  minify: !isDebug,
  write: false,
});
const loaderWorkerSource = loaderWorker.outputFiles[0].text;

const loaderMain = await context({
  ...loaderBrowser,
  entryPoints: [fromRoot("src/loader/entry.ts")],
  format: "iife",
  sourcemap: isDebug ? "external" : false,
  define: {
    ...loaderBrowser.define,
    __LOADER_WORKER_SOURCE__: JSON.stringify(loaderWorkerSource),
  },
  outfile: loaderOut,
  minify: !isDebug,
  banner: {
    js:
      userscriptMetadataGenerator({
        ...loaderMeta,
        version: pkg.version,
      }).replace("// @run-at", "// @noframes\n// @run-at") + "\n/*eslint-disable*/",
  },
});

await loaderMain.rebuild();
await loaderMain.dispose();
console.log("produced", loaderOut);

const sketchMain = await context({
  alias: loaderBrowser.alias,
  entryPoints: [fromRoot("src/index.ts")],
  format: "iife",
  sourcemap: isDebug ? "external" : false,
  define: {
    ...loaderBrowser.define,
    __LOADER_WORKER_SOURCE__: JSON.stringify(loaderWorkerSource),
  },
  outfile: mainOut,
  external: [
    ...loaderBrowser.external,
    "os",
    "fs",
    "path",
    "http",
    "https",
    "electron",
  ],
  loader: loaderBrowser.loader,
  bundle: true,
  minify: !isDebug,
  jsx: "transform",
  supported: {
    "nullish-coalescing": false,
    "optional-catch-binding": false,
    "optional-chain": false,
  },
  plugins: [
    ...(isDevelopment ? [] : [obfuscate()]),
    {
      name: "heyyy",
      setup: (build) => {
        build.onEnd(() => {
          console.log("built sketch", pkg.version, "GG!!");
          console.log(new Date());
          console.log("i love you");
        });
      },
    },
  ],
  platform: "browser",
  banner: {
    js:
      userscriptMetadataGenerator({
        ...sketchMeta,
        version: pkg.version,
        // connect: [new URL(process.env.SKETCH_API_URL).hostname],
      }).replace("// @run-at", "// @noframes\n// @run-at") + "\n/*eslint-disable*/",
  },
});

console.log("produced", mainOut);

if (isDevelopment) {
  const devOut = fromRoot("dist/sketch.DEV.user.js");
  await build({
    entryPoints: [fromRoot("src/dev.ts")],
    format: "iife",
    define: envReplacements,
    outfile: devOut,
    platform: "browser",
    banner: {
      js:
        userscriptMetadataGenerator({
          author: pkg.author,
          description: pkg.description,
          version: pkg.version,
          ...sketchMeta,
          ...sketchDevMeta,
          // connect: [new URL(process.env.SKETCH_API_URL).hostname],
        }) + "\n",
    },
  });

  console.log("produced", devOut);

  const loaderDevOut = fromRoot("dist/loader.DEV.user.js");
  await build({
    entryPoints: [fromRoot("src/loader/entry.dev.ts")],
    format: "iife",
    define: envReplacements,
    outfile: loaderDevOut,
    bundle: true,
    platform: "browser",
    banner: {
      js:
        userscriptMetadataGenerator({
          author: pkg.author,
          description: pkg.description,
          version: pkg.version,
          ...loaderMeta,
          ...loaderDevMeta,
        }) + "\n",
    },
  });
  console.log("produced", loaderDevOut);

  if (!process.argv.includes("--watch")) {
    await sketchMain.rebuild();
    await sketchMain.dispose();
    process.exit(0);
  }


  const server = http.createServer();
  server.on("request", (req, res) =>
    send(req, parseUrl(req).pathname, {
      root: fromRoot("dist"),
    }).then(({ statusCode, headers, stream }) => {
      headers["access-control-request-method"] = "GET, POST, OPTIONS";
      headers["access-control-allow-origin"] = "https://krunker.io";
      headers["access-control-allow-headers"] =
        "cache-control, content-type, accept";
      headers["cache-control"] = "no-cache";

      // normalize the url
      if ("Location" in headers) headers.Location = "/cdn" + headers.Location;
      stream.pipe(res);
      res.writeHead(statusCode, headers);
    })
  );

  server.on("listening", () => {
    console.log("dev server started on http://127.0.0.1:8080/");
  });

  server.listen({
    host: "127.0.0.1",
    port: process.env.SKETCH_DEV_API_PORT || 8080,
  });

  await sketchMain.watch();
} else {
  await sketchMain.rebuild();
  await sketchMain.dispose();
}
