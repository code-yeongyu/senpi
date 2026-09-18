#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
const banner = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};
const allowedExternalPackages = new Set([
	"@earendil-works/chord",
	"@earendil-works/chord/bundler",
	"@earendil-works/chord/context",
	"@earendil-works/chord/delta",
	"@earendil-works/chord/node",
	"@silvia-odwyer/photon-node",
	// The native PTY loader resolves its manifest and prebuilds beside its package.
	"@earendil-works/pi-pty",
	// Runtime-guarded Bun lock adapter; Node uses node:sqlite instead.
	"bun:sqlite",
	// Runtime-guarded host child reaper bindings; a Node host turns the reaper off.
	"bun:ffi",
	// Optional ws accelerators; kept external so the binding loader stays out of the bundle.
	"bufferutil",
	"utf-8-validate",
	// linkedom's optional native canvas stays package-relative, with its JS fallback.
	"canvas",
	// Optional native accelerators. Their callers fall back to JavaScript when absent.
	"bufferutil",
	"utf-8-validate",
	// Optional native proxy authentication. Its caller reports an install hint when absent.
	"kerberos",
	// Optional debug output coloring.
	"supports-color",
]);

// Only standalone Bun isolates register these modules. esbuild follows the worker's
// literal import even behind isBunBinary; keep that unreachable graph out of Node.
const bunRuntimeModulesPlugin = {
	name: "omit-bun-runtime-modules",
	setup(build) {
		build.onResolve({ filter: /[/\\\\]bun[/\\\\]runtime-modules\.(ts|js)$/ }, (args) => ({
			namespace: "bun-runtime-modules",
			path: args.path,
		}));
		build.onLoad({ filter: /.*/, namespace: "bun-runtime-modules" }, () => ({
			contents: "export {};",
			loader: "js",
		}));
	},
};

// Bun's file attribute is not a standard Node import attribute. Let esbuild
// emit the asset and its path rather than parse it as a JavaScript module.
const fileAttributePlugin = {
	name: "file-attribute",
	setup(build) {
		build.onLoad({ filter: /./, namespace: "file" }, (args) => {
			if (args.with.type !== "file") return undefined;
			return { contents: readFileSync(args.path), loader: "file" };
		});
	},
};

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: repoRoot,
			}),
		);
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		external: [
			"@earendil-works/chord",
			"@silvia-odwyer/photon-node",
			"@earendil-works/pi-pty",
			"bun:sqlite",
			"bun:ffi",
			// ws resolves these native accelerators when they happen to be installed.
			// They load their binding through node-gyp-build, whose computed require
			// esbuild cannot analyse, so bundling them leaves an unresolvable external.
			"bufferutil",
			"canvas",
			"utf-8-validate",
		],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		plugins: [httpsProxyAgentNamedExportPlugin, bunRuntimeModulesPlugin, fileAttributePlugin],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "client", "index.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		cli: join(codingAgentDistDir, "cli.js"),
		client: join(codingAgentDistDir, "client", "index.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
	},
	outdir: bundleDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/api/bedrock-converse-stream.lazy.js");
const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/auth/oauth/load.js");
const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");
if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
	throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
}

// These implementations are reached through variable-specifier imports or a
// worker URL, so the main bundle cannot follow them. Emit one self-contained
// file per implementation beside the code that resolves it.
const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		anthropic: join(aiDistDir, "auth", "oauth", "anthropic.js"),
		"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
		devin: join(aiDistDir, "auth", "oauth", "devin.js"),
		"devin-agent": join(aiDistDir, "api", "devin-agent.js"),
		"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
		"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
		"session-worker": join(codingAgentDistDir, "modes", "rpc", "session-worker.js"),
		"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
		"openai-codex": join(aiDistDir, "auth", "oauth", "openai-codex.js"),
		openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
		radius: join(aiDistDir, "auth", "oauth", "radius.js"),
		xai: join(aiDistDir, "auth", "oauth", "xai.js"),
	},
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});

const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}

validateExternalImports([mainResult.metafile, lazyResult.metafile]);
chmodSync(join(bundleDir, "cli.js"), 0o755);
chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);

const files = new Set([...Object.keys(mainResult.metafile.outputs), ...Object.keys(lazyResult.metafile.outputs)]).size;
const mib = outputBytes([mainResult.metafile, lazyResult.metafile]) / (1024 * 1024);
console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
