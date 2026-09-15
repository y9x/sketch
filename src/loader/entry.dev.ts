export {};

const devHost = process.env.SKETCH_DEV_API_HOST || "127.0.0.1";
const devPort = process.env.SKETCH_DEV_API_PORT || "8080";
const devApiURL = `http://${devHost}:${devPort}/`;

const legacyGet =
  typeof GM_getValue === "function" ? GM_getValue.bind(globalThis) : undefined;
const legacySet =
  typeof GM_setValue === "function" ? GM_setValue.bind(globalThis) : undefined;
const legacyDelete =
  typeof GM_deleteValue === "function"
    ? GM_deleteValue.bind(globalThis)
    : undefined;
const legacyList =
  typeof GM_listValues === "function"
    ? GM_listValues.bind(globalThis)
    : undefined;

Object.defineProperty(globalThis, "__sketchLoaderStorage", {
  configurable: true,
  value: {
    get: legacyGet,
    set: legacySet,
    delete: legacyDelete,
    list: legacyList,
  },
});

const http = new XMLHttpRequest();
http.open("GET", new URL("loader.user.js", devApiURL), false);
http.setRequestHeader("cache-control", "no-cache");
http.send();
eval(
  http.response +
    `\n//# sourceMappingURL=${new URL("loader.user.js.map", devApiURL)}`,
);
