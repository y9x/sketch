// The verify harnesses import loader .ts/.wasm directly, so esbuild has to bundle them before node can run them.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
if (!name) {
  console.error("usage: run-bundled.mjs <verify-derive|verify-signature|probe-fp|...>");
  process.exit(2);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `/tmp/sketch-${name}.mjs`;

const bundle = spawnSync(
  `${root}node_modules/.bin/esbuild`,
  [
    `${here}${name}.mjs`,
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${out}`,
    "--loader:.wasm=base64",
    "--loader:.bin=base64",
    "--log-level=error",
  ],
  { stdio: "inherit" }
);
if (bundle.status !== 0) process.exit(bundle.status ?? 1);

const run = spawnSync("node", [out], { stdio: "inherit", cwd: root });
process.exit(run.status ?? 1);
