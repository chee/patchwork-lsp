import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const watch = process.argv.includes("--watch");

// Bundle the extension
const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.js",
  sourcemap: true,
  external: ["vscode"],
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}

// Copy the LSP server into the extension's dist
const serverSrc = path.resolve("..", "dist", "server.cjs");
const serverDest = path.resolve("dist", "server.cjs");
if (fs.existsSync(serverSrc)) {
  fs.copyFileSync(serverSrc, serverDest);
  // Copy sourcemap too if it exists
  const mapSrc = serverSrc + ".map";
  if (fs.existsSync(mapSrc)) {
    fs.copyFileSync(mapSrc, serverDest + ".map");
  }
  console.log("Copied server.cjs into extension dist/");
} else {
  console.warn("Warning: server.cjs not found at", serverSrc);
  console.warn("Run 'pnpm build' in the root first.");
}

// Install server dependencies into dist/node_modules so they ship with the vsix.
// server.cjs has @automerge/vanillajs as an external require (WASM can't be bundled).
const distPkg = path.resolve("dist", "package.json");
fs.writeFileSync(
  distPkg,
  JSON.stringify({
    private: true,
    dependencies: {
      "@automerge/vanillajs": "latest",
    },
  })
);

console.log("Installing server dependencies into dist/node_modules...");
execSync("npm install --omit=dev --ignore-scripts", {
  cwd: path.resolve("dist"),
  stdio: "inherit",
});

// Clean up the temporary package.json and lockfile
fs.unlinkSync(distPkg);
const distLock = path.resolve("dist", "package-lock.json");
if (fs.existsSync(distLock)) fs.unlinkSync(distLock);

console.log("Server dependencies installed.");
