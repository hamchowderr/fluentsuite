// Bundles MCP Apps views into single, self-contained HTML files (script and styles inlined).
// Usage from a product package: node ../core/scripts/build-views.mjs <outDir> <entry.ts>...
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const baseCss = await readFile(join(here, "..", "ui", "base.css"), "utf8");

export async function buildViews(outDir, entries) {
  await mkdir(outDir, { recursive: true });
  for (const entry of entries) {
    const name = basename(entry).replace(/\.ts$/, "");
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "none",
      conditions: ["@fluentsuite/source"],
      logLevel: "warning",
    });
    const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>${baseCss}</style>
</head>
<body>
<div id="app" class="card"><div class="empty muted">Loading…</div></div>
<script type="module">${script}</script>
</body>
</html>
`;
    await writeFile(join(outDir, `${name}.html`), html);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outDir, ...entries] = process.argv.slice(2);
  if (!outDir || entries.length === 0) {
    console.error("usage: build-views.mjs <outDir> <entry.ts>...");
    process.exit(1);
  }
  await buildViews(
    resolve(outDir),
    entries.map((e) => resolve(e)),
  );
}
