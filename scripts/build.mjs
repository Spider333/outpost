// Builds dist/: the web client (one JS bundle + html + css) and the client server.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/web", { recursive: true });
await build({
  entryPoints: ["src/web/app.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: "dist/web/app.js",
  // Test-data library pulled in by @farcaster/core; see src/web/faker-stub.ts.
  alias: { "@faker-js/faker": "./src/web/faker-stub.ts" },
  logLevel: "warning",
});
await build({
  entryPoints: ["src/server/serve.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  outfile: "dist/serve.js",
  logLevel: "warning",
});
await copyFile("src/web/index.html", "dist/web/index.html");
await copyFile("src/web/style.css", "dist/web/style.css");
console.log("built dist/web and dist/serve.js");
