#!/usr/bin/env node

import { readFileSync } from "node:fs";

const assetPrefix = "senpi-bundle-file-asset:";
const assetNamespace = "senpi-bundle-file-asset";

/**
 * Bundles Bun's `import(..., { with: { type: "file" } })` so the default export keeps Bun's
 * contract: an absolute path to the shipped asset.
 *
 * esbuild's `file` loader emits the asset but inlines a path relative to the output file that
 * contains it (`"../SKILL-<hash>.md"`). Callers hand that string to `existsSync`, which resolves it
 * against `process.cwd()`, so every bundled asset looked missing outside the chunks directory.
 * Each file import therefore becomes a wrapper that resolves the emitted path against its own
 * `import.meta.url`. The asset module is reached only through its wrapper, so esbuild places the
 * two in the same output file or in sibling chunks, and the relative path stays valid.
 */
export const fileAttributePlugin = {
	name: "file-attribute",
	setup(build) {
		build.onLoad({ filter: /./, namespace: "file" }, (args) => {
			if (args.with.type !== "file") return undefined;
			return {
				contents: [
					'import { fileURLToPath } from "node:url";',
					`import emittedPath from ${JSON.stringify(`${assetPrefix}${args.path}`)};`,
					"export default fileURLToPath(new URL(emittedPath, import.meta.url));",
				].join("\n"),
				loader: "js",
			};
		});
		build.onResolve({ filter: new RegExp(`^${assetPrefix}`) }, (args) => ({
			path: args.path.slice(assetPrefix.length),
			namespace: assetNamespace,
		}));
		build.onLoad({ filter: /./, namespace: assetNamespace }, (args) => ({
			contents: readFileSync(args.path),
			loader: "file",
		}));
	},
};
