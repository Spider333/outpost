// Builds dist/: the web client (one JS bundle + html + css) and the client server.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";

// The commit the web client is built from, shown in its footer. CI sets GITHUB_SHA.
function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const git = (args) => execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return git("rev-parse HEAD") + (git("status --porcelain") ? "-dirty" : "");
  } catch {
    return "unknown"; // not a git checkout
  }
}

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
  define: { __OUTPOST_COMMIT__: JSON.stringify(commit()) },
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
await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  outfile: "dist/cli.js",
  alias: { "@faker-js/faker": "./src/web/faker-stub.ts" },
  // Some bundled CommonJS code calls require(); give ESM output a require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
// The society sponsor, one file the server runs as it is (see infra/society.sh).
await build({
  entryPoints: ["src/server/sponsor.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  outfile: "dist/sponsor.js",
  logLevel: "warning",
});
// "Approve in the Farcaster app" on a society node, one file like the sponsor.
await build({
  entryPoints: ["src/server/appsignin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  outfile: "dist/appsignin.js",
  alias: { "@faker-js/faker": "./src/web/faker-stub.ts" },
  logLevel: "warning",
});
await copyFile("src/web/index.html", "dist/web/index.html");
await copyFile("src/web/style.css", "dist/web/style.css");
console.log("built dist/web, dist/serve.js, dist/cli.js, dist/sponsor.js and dist/appsignin.js");
