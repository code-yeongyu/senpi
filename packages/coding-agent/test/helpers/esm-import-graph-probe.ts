import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ImportGraphProbeResult {
	entries: Array<{ phase: "resolve" | "load"; specifier?: string; url: string }>;
	globalsAdded: string[];
	stdout: string;
}

// senpi#5818: synchronous in-thread hooks with one write at exit. `register()` ran the hooks on a separate thread and
// appended every event to the log, so each of the ~5,250 events cost a cross-thread round trip plus an
// open/write/close; on a starved host that, not the import, took the test past its timeout. The recorded set stays the
// one `register()` produced: `require()` resolves (and the CommonJS loads only they reach) are skipped, and each URL's
// load is recorded once (in-thread hooks see a builtin's load on every import of it).
const hookSource = `
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const lines = [];
const imported = new Set();
const loaded = new Set();
process.on("exit", () => writeFileSync(process.env.PI_IMPORT_GRAPH_LOG, lines.join("")));
const fromRequire = (context) => Array.isArray(context.conditions) && context.conditions.includes("require");
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!fromRequire(context)) {
      imported.add(result.url);
      lines.push(JSON.stringify({ phase: "resolve", specifier, url: result.url }) + "\\n");
    }
    return result;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (imported.has(url) && !loaded.has(url)) {
      loaded.add(url);
      lines.push(JSON.stringify({ phase: "load", url }) + "\\n");
    }
    return result;
  },
});
`;

const driverSource = `
const before = new Set(Reflect.ownKeys(globalThis).map(String));
await import(process.argv[2]);
const globalsAdded = Reflect.ownKeys(globalThis).map(String).filter((key) => !before.has(key));
console.log(JSON.stringify({ globalsAdded }));
`;

/**
 * Records the static-import graph Node actually walks while importing
 * `entryPath`, using the same loader-hook probe as
 * `probeModelRuntimeImport`. Deferred (`await import(...)`) modules never
 * appear, so the result is the startup graph a cold CLI process pays for.
 */
export function probeImportGraph(repoRoot: string, entryPath: string): ImportGraphProbeResult {
	return runImportProbe(repoRoot, resolve(entryPath), "pi-import-graph-");
}

export function probeModelRuntimeImport(repoRoot: string, target: "source" | "built"): ImportGraphProbeResult {
	const targetPath =
		target === "source"
			? join(repoRoot, "packages/coding-agent/src/core/model-runtime.ts")
			: join(repoRoot, "packages/coding-agent/dist/core/model-runtime.js");
	return runImportProbe(repoRoot, resolve(targetPath), "pi-model-runtime-import-");
}

function runImportProbe(repoRoot: string, targetPath: string, scratchPrefix: string): ImportGraphProbeResult {
	const scratch = mkdtempSync(join(tmpdir(), scratchPrefix));
	const logPath = join(scratch, "graph.jsonl");
	writeFileSync(join(scratch, "register.mjs"), hookSource);
	writeFileSync(join(scratch, "driver.mjs"), driverSource);
	// senpi#5177: this probe used to symlink packages/coding-agent/node_modules/@earendil-works/pi-ai -> packages/ai
	// for the run and remove it afterwards (added with the built model-runtime probe, ce1bfc287a), to pin pi-ai to the
	// probed checkout's own package. It is not needed: every caller asserts assertWorkspaceBuildPrerequisite, which
	// proves pi-ai already resolves into this checkout, and the walked graphs are identical without it (host-lifecycle
	// 70 modules, model-runtime 1,280). It was harmful: the link lived in the shared tree, so a host child in another
	// worker could resolve pi-ai through it and then read dist/index.js after the probe removed it.
	try {
		const args = ["--import", join(scratch, "register.mjs"), join(scratch, "driver.mjs"), targetPath];
		// Node's loader hooks are the probe, including when Vitest itself runs under Bun.
		const child = spawnSync(process.versions.bun ? "node" : process.execPath, args, {
			cwd: repoRoot,
			env: { ...process.env, PI_IMPORT_GRAPH_LOG: logPath },
			encoding: "utf8",
		});
		if (child.status !== 0) throw new Error(`Import probe failed (${targetPath}): ${child.stderr || child.stdout}`);
		const output = JSON.parse(child.stdout.trim()) as { globalsAdded: string[] };
		const entries = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ImportGraphProbeResult["entries"][number]);
		return { entries, globalsAdded: output.globalsAdded, stdout: child.stdout.trim() };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export const importGraphHookSource = hookSource;
