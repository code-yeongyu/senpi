import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const outputPath = join(tmpdir(), "pi-browser-smoke.js");
const agentTreeshakeOutputPath = join(tmpdir(), "pi-agent-treeshake-smoke.js");
const errorLogPath = join(tmpdir(), "pi-browser-smoke-errors.log");
const generatedCatalogDataDir = join(process.cwd(), "packages/ai/src/providers/data");

// Fresh checkouts do not materialize provider JSON until model data is hydrated.
const generatedCatalogDataPlugin = {
	name: "generated-model-catalog",
	setup(build) {
		build.onResolve({ filter: /^\.\/data\/[^/]+\.json$/ }, (args) => {
			const path = resolve(dirname(args.importer), args.path);
			if (dirname(path) !== generatedCatalogDataDir || existsSync(path)) return;
			return { path, namespace: "empty-generated-model-catalog" };
		});
		build.onLoad({ filter: /.*/, namespace: "empty-generated-model-catalog" }, () => ({
			contents: "{}",
			loader: "json",
		}));
	},
};

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

// @anthropic-ai/sdk >=0.93.0 ships a Node-only credentials subsystem
// (config profiles, identity-token files, user OAuth) that reaches `node:fs`
// and `node:path` through dynamic `await import(...)` calls the SDK guards at
// runtime, so browsers never execute them. esbuild still hard-errors on the
// unresolvable builtins when bundling for the browser. The claude-agent-sdk
// peer floor forces >=0.93.0, so this is upstream's documented browser story
// rather than something we can pin our way out of.
//
// Scoped deliberately to importers inside node_modules/@anthropic-ai/sdk: the
// guardrail must keep failing when senpi's own browser-facing code imports a
// Node builtin.
const anthropicSdkImporterMarker = "node_modules/@anthropic-ai/sdk/";
const anthropicSdkNodeBuiltinsPlugin = {
	name: "anthropic-sdk-node-builtins",
	setup(build) {
		build.onResolve({ filter: /^node:/ }, (args) => {
			if (!normalizePath(args.importer).includes(anthropicSdkImporterMarker)) return;
			return { path: args.path, external: true };
		});
	},
};

function findInput(inputs, suffix) {
	return Object.keys(inputs).find((input) => {
		const normalized = normalizePath(input);
		return normalized === suffix || normalized.endsWith(`/${suffix}`);
	});
}

function includesNodePackage(inputs, packageName) {
	const marker = `node_modules/${packageName}/`;
	return Object.keys(inputs).some((input) => normalizePath(input).includes(marker));
}

try {
	await build({
		entryPoints: ["scripts/browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		outfile: outputPath,
		plugins: [generatedCatalogDataPlugin, anthropicSdkNodeBuiltinsPlugin],
	});

	const agentTreeshakeBuild = await build({
		entryPoints: ["scripts/agent-treeshake-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: agentTreeshakeOutputPath,
		plugins: [generatedCatalogDataPlugin, anthropicSdkNodeBuiltinsPlugin],
		write: false,
	});
	const inputs = agentTreeshakeBuild.metafile.inputs;
	for (const forbiddenInput of [
		"packages/ai/src/compat.ts",
		"packages/ai/src/models.generated.ts",
		"packages/ai/src/providers/all.ts",
	]) {
		const includedInput = findInput(inputs, forbiddenInput);
		if (includedInput) {
			throw new Error(`Agent selective-provider bundle unexpectedly includes ${includedInput}`);
		}
	}

	const contributingInputs = new Set(
		Object.values(agentTreeshakeBuild.metafile.outputs).flatMap((output) =>
			Object.entries(output.inputs)
				.filter(([, contribution]) => contribution.bytesInOutput > 0)
				.map(([input]) => input),
		),
	);
	const catalogInputs = Array.from(contributingInputs).filter((input) =>
		normalizePath(input).includes("packages/ai/src/providers/data/"),
	);
	if (catalogInputs.length !== 1 || !normalizePath(catalogInputs[0]).endsWith("/anthropic.json")) {
		throw new Error(
			`Agent selective-provider bundle catalogs: expected only anthropic.json, found ${catalogInputs.join(", ") || "none"}`,
		);
	}

	const aiSdkPackages = [
		"@anthropic-ai/sdk",
		"@aws-sdk/client-bedrock-runtime",
		"@google/genai",
		"@mistralai/mistralai",
		"openai",
	];
	const includedAiSdkPackages = aiSdkPackages.filter((packageName) => includesNodePackage(inputs, packageName));
	if (
		includedAiSdkPackages.length !== 1 ||
		includedAiSdkPackages[0] !== "@anthropic-ai/sdk"
	) {
		throw new Error(
			`Agent selective-provider bundle SDKs: expected only @anthropic-ai/sdk, found ${includedAiSdkPackages.join(", ") || "none"}`,
		);
	}

	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
