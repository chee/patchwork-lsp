import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/server.cjs",
  sourcemap: true,
  // Automerge has WASM that can't be bundled — keep all automerge packages external
  external: ["@automerge/*"],
});

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
