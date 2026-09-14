import { pageWindow } from "./env"
import { diag, log } from "./log"
import {
  type GameParams,
  type RenamedAlias,
  recoverParams,
  recoverRenamed,
} from "./params"

export type ExecutionMetadata = {
  params: GameParams
  renamed: RenamedAlias[]
}

export function executeGame(
  source: string,
  token: string,
  metadata?: ExecutionMetadata
): void {
  const win = pageWindow()
  const { token: tokenParam, callback: callbackParam } =
    metadata?.params || recoverParams(source)
  const globals = win as unknown as Record<string, unknown>

  // The bundle reads renamed globals as explicit window properties and later
  // reassigns them, so they must live on window rather than be parameters --
  // a parameter would shadow the game's own reassignment.
  const renamed = metadata?.renamed || recoverRenamed(source, win)
  for (const alias of renamed) {
    const had = typeof globals[alias.name]
    globals[alias.name] = globals[alias.global]
    log.info(
      `renamed global: ${alias.global} -> ${alias.name} (was ${had}, now ${typeof globals[alias.name]})`
    )
  }

  const names = [tokenParam, callbackParam]
  const values: unknown[] = [token, undefined]

  diag().params = names
  log.info(`recovered params: ${names.join(", ")}`)

  const probe = [
    "requestAnimationFrame",
    "requestIdleCallback",
    "FRVR",
    "Howl",
    "THREE",
  ]
    .map((k) => `${k}=${typeof (win as unknown as Record<string, unknown>)[k]}`)
    .join(" ")
  log.info(
    `realm: escapedSandbox=${win !== window} readyState=${win.document.readyState} ${probe}`
  )

  // Compile with the page's Function so the game runs in the page realm, not
  // inside the userscript sandbox.
  // sourceURL gives stack frames a real position, which is the only way to
  // locate a fault inside the single-line bundle.
  const annotated = `${source}\n//# sourceURL=https://krunker.io/js/app.js`
  const PageFunction = (win as unknown as { Function: FunctionConstructor })
    .Function
  const run = new PageFunction(...names, annotated)
  try {
    run.apply(win, values)
  } catch (error) {
    const stack = error instanceof Error && error.stack ? error.stack : String(error)
    log.error("game body threw:", String(stack).replace(/\n/g, " | ").slice(0, 700))
    throw error
  }
}
