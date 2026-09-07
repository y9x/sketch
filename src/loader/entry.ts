import { boot } from "./index"

boot().catch((error) => {
  console.error("[krunker-loader]", error)
})
