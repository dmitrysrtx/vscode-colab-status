import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "node20",
    outfile: "dist/extension.js",
    external: ["vscode"],
    define: {
      __DEFAULT_OAUTH_CLIENT_ID__: JSON.stringify(
        process.env.COLAB_OAUTH_CLIENT_ID || ""
      ),
      __DEFAULT_OAUTH_CLIENT_SECRET__: JSON.stringify(
        process.env.COLAB_OAUTH_CLIENT_SECRET || ""
      ),
    },
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
