const devHost = process.env.SKETCH_DEV_API_HOST || "127.0.0.1";
const devPort = process.env.SKETCH_DEV_API_PORT || "8080";
const devApiURL = `http://${devHost}:${devPort}/`;

const http = new XMLHttpRequest();
http.open("GET", new URL("loader.user.js", devApiURL), false);
http.setRequestHeader("cache-control", "no-cache");
http.send();
eval(
  http.response +
    `\n//# sourceMappingURL=${new URL("loader.user.js.map", devApiURL)}`,
);
