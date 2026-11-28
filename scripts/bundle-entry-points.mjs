import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The compiled module an `exports` entry is built from: its `types` declaration's `.js` sibling. Its `import` condition
 * names the bundle's output for it (`./dist/bundle/<name>.js`), which the bundle build writes, so it cannot be the input.
 */
export function compiledModuleOf(conditions) {
	return conditions.types.replace(/\.d\.ts$/, ".js");
}

/**
 * One entry of the main split build per `exports` subpath of the coding-agent manifest whose `import` condition is a
 * module, named for the subpath (`.` is `index`, matching `./dist/bundle/<name>.js`) and built from its compiled module.
 * Sharing one split build gives every subpath the same module instances as `cli.js`. A data export of a file the bundle
 * itself writes (`./runtime-manifest.json`) has no `import` condition and no entry.
 */
export function exportEntryPoints({ codingAgentDistDir }) {
	const codingAgentDir = dirname(codingAgentDistDir);
	const { exports } = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	return Object.fromEntries(
		Object.entries(exports)
			.filter(([, conditions]) => conditions.import?.endsWith(".js"))
			.map(([subpath, conditions]) => [
				subpath === "." ? "index" : subpath.slice(2),
				join(codingAgentDir, compiledModuleOf(conditions)),
			]),
	);
}

/**
 * Compiled modules the release bundle reads directly; the build refuses to start while one is missing.
 * `bundle-entry-paths.test.mjs` maps each back to its source so a deleted or renamed module fails there.
 */
export function bundleRequiredInputs({ codingAgentDistDir, aiDistDir }) {
	return [
		...new Set([join(codingAgentDistDir, "cli.js"), ...Object.values(exportEntryPoints({ codingAgentDistDir }))]),
		join(codingAgentDistDir, "modes", "rpc", "host-supervisor-entry.js"),
		join(codingAgentDistDir, "utils", "image-resize-worker.js"),
		join(codingAgentDistDir, "core", "extensions", "builtin", "permission-system", "path-identity-worker.js"),
		join(aiDistDir, "api", "bedrock-converse-stream.js"),
	];
}

/**
 * Implementations reached through variable-specifier imports or a worker URL, which the main
 * bundle cannot follow: one self-contained file per implementation, emitted beside the code that
 * resolves it.
 */
export function lazyEntryPoints({ codingAgentDistDir, aiDistDir }) {
	return {
		"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
		cursor: join(aiDistDir, "auth", "oauth", "cursor.js"),
		"cursor-agent": join(aiDistDir, "api", "cursor-agent.js"),
		devin: join(aiDistDir, "auth", "oauth", "devin.js"),
		"devin-agent": join(aiDistDir, "api", "devin-agent.js"),
		"github-copilot": join(aiDistDir, "auth", "oauth", "github-copilot.js"),
		// `supervisor-route.js` defers this with a dynamic `import("./host-lifecycle.js")`
		// so the RPC host graph stays out of every launch. `session-worker` is bundled
		// here with splitting off, which leaves that specifier unresolved beside the
		// emitted file - so the implementation has to exist there under that exact name,
		// or `host ensure` dies with "Module not found .../chunks/host-lifecycle.js".
		"host-lifecycle": join(codingAgentDistDir, "modes", "rpc", "host-lifecycle.js"),
		"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
		// Codemode workers import the kill guard's judge by URL from `kill-guard/host.js` (checked after the build).
		"kill-guard": join(codingAgentDistDir, "core", "kill-guard", "index.js"),
		// The runtime shims run this judge entry under Node for an npm install (checked after the build).
		"kill-guard-check": join(codingAgentDistDir, "core", "kill-guard", "check-entry.js"),
		// `path-identity-host.js` starts this with new URL("./path-identity-worker.js", import.meta.url), so
		// the worker must sit in the chunk directory the host is emitted into (checked after the build).
		"path-identity-worker": join(
			codingAgentDistDir,
			"core",
			"extensions",
			"builtin",
			"permission-system",
			"path-identity-worker.js",
		),
		"session-worker": join(codingAgentDistDir, "modes", "rpc", "session-worker.js"),
		"kimi-coding": join(aiDistDir, "auth", "oauth", "kimi-coding.js"),
		meta: join(aiDistDir, "auth", "oauth", "meta.js"),
		"openai-chatgpt": join(aiDistDir, "auth", "oauth", "openai-chatgpt.js"),
		"chatgpt-subscription": join(aiDistDir, "auth", "oauth", "chatgpt-subscription.js"),
		openrouter: join(aiDistDir, "auth", "oauth", "openrouter.js"),
		radius: join(aiDistDir, "auth", "oauth", "radius.js"),
		xai: join(aiDistDir, "auth", "oauth", "xai.js"),
	};
}
