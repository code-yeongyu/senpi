#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleRequiredInputs, lazyEntryPoints } from "./bundle-entry-points.mjs";
import { fileAttributePlugin } from "./bundle-file-attribute-plugin.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");
// undici's CacheStorage instantiates at module init and calls
// worker_threads.markAsUncloneable, a Node >= 23 API that Bun 1.3.x lacks (#1806).
// Every emitted file evaluates this prologue before any bundled module code.
const runtimeGuards =
	'{ const __piWorkerThreads = require("node:worker_threads"); if (typeof __piWorkerThreads.markAsUncloneable !== "function") { __piWorkerThreads.markAsUncloneable = () => {}; } }';
const banner = {
	js: `import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url); ${runtimeGuards}`,
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

export function commonBuildOptions() {
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

export function validateExternalImports(metafiles) {
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

/** Package names the bundle imports at runtime, so a relocated copy can resolve them the same way. */
export function collectExternalPackages(metafiles) {
	const names = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || imported.path.startsWith("bun:")) continue;
				const segments = imported.path.split("/");
				names.add(imported.path.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]);
			}
		}
	}
	return Array.from(names).sort();
}

/**
 * `runtime-manifest.json` names this exact build (a content hash of every emitted file) for the
 * CLI's runtime snapshot (`packages/coding-agent/src/runtime-snapshot/`), which keeps a running
 * session on its own build when a package manager rewrites the install (#2358).
 */
function writeRuntimeManifest(metafiles) {
	const hash = createHash("sha256");
	for (const file of readdirSync(bundleDir, { recursive: true }).map(String).sort()) {
		const path = join(bundleDir, file);
		if (!statSync(path).isFile()) continue;
		hash.update(file.replaceAll("\\", "/")).update("\0").update(readFileSync(path));
	}
	const manifest = { buildId: hash.digest("hex").slice(0, 16), externals: collectExternalPackages(metafiles) };
	writeFileSync(join(bundleDir, "runtime-manifest.json"), `${JSON.stringify(manifest)}\n`);
}

export function findContainingOutput(metafile, inputSuffix) {
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

async function buildBundle() {
	for (const entry of bundleRequiredInputs({ codingAgentDistDir, aiDistDir })) {
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

	const lazy = lazyEntryPoints({ codingAgentDistDir, aiDistDir });

	// Every OAuth flow loaded through importOAuthModule() must have a lazy entry,
	// otherwise the flow fails at runtime with a missing module error.
	const oauthLoadSource = readFileSync(join(repoRoot, "packages", "ai", "src", "auth", "oauth", "load.ts"), "utf8");
	for (const match of oauthLoadSource.matchAll(/importOAuthModule\("\.\/([^"]+)\.ts"\)/g)) {
		if (!(match[1] in lazy)) {
			throw new Error(`OAuth flow "${match[1]}" is lazily imported but has no lazy bundle entry`);
		}
	}

	const lazyResult = await build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: lazy,
		outdir: dirname(bedrockLoaderOutput),
		splitting: false,
	});

	const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
	if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
		throw new Error("Image resize implementation and worker were emitted into different directories");
	}
	const pathIdentityHostOutput = findContainingOutput(
		mainResult.metafile,
		"packages/coding-agent/dist/core/extensions/builtin/permission-system/path-identity-host.js",
	);
	if (dirname(pathIdentityHostOutput) !== dirname(bedrockLoaderOutput)) {
		throw new Error("Path identity host and its resolver worker were emitted into different directories");
	}
	// `kill-guard/host.js` hands codemode workers new URL("./kill-guard.js", import.meta.url) (senpi#5349).
	const killGuardHostOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/core/kill-guard/host.js");
	if (dirname(killGuardHostOutput) !== dirname(bedrockLoaderOutput)) {
		throw new Error("Kill guard host and its judge module were emitted into different directories");
	}

	const supervisorResult = await buildSupervisor();

	const metafiles = [mainResult.metafile, lazyResult.metafile, supervisorResult.metafile];
	validateExternalImports(metafiles);
	chmodSync(join(bundleDir, "cli.js"), 0o755);
	chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);
	writeRuntimeManifest(metafiles);

	const files = new Set(metafiles.flatMap((metafile) => Object.keys(metafile.outputs))).size;
	const mib = outputBytes(metafiles) / (1024 * 1024);
	console.log(`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB)`);
}

// The lifecycle supervisor's own program (senpi#3743): self-contained beside cli.js, so a supervisor loads
// only its own graph instead of booting the whole CLI to reach `--internal-rpc-host-supervisor`.
function buildSupervisor() {
	return build({
		...commonBuildOptions(),
		entryNames: "[name]",
		entryPoints: { "host-supervisor": join(codingAgentDistDir, "modes", "rpc", "host-supervisor-entry.js") },
		outdir: bundleDir,
		splitting: false,
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	await buildBundle();
}
