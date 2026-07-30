import { build } from "esbuild";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const fc = join(root, "fc");
const output = join(fc, "dist");
const staticAssets = join(fc, "static-assets.ts");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return paths.flat();
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const assets = Object.fromEntries(
  (
    await Promise.all(
      (
        await files(dist)
      ).map(async (path) => {
        const publicPath = `/${relative(dist, path)}`;
        return [
          publicPath,
          {
            body: (await readFile(path)).toString("base64"),
            contentType: contentTypes[extname(path)] ?? "application/octet-stream",
          },
        ];
      }),
    )
  ).sort(([left], [right]) => left.localeCompare(right)),
);
await writeFile(staticAssets, `export default ${JSON.stringify(assets)};\n`);
await build({
  bundle: true,
  entryPoints: [join(fc, "handler.ts")],
  format: "cjs",
  outfile: join(output, "index.cjs"),
  platform: "node",
  target: "node22",
});
