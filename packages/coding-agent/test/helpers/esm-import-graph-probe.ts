import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ImportGraphProbeResult {
	entries: Array<{ phase: "resolve" | "load"; specifier?: string; url: string }>;
	globalsAdded: string[];
	stdout: string;
}

const hookSource = `
import { appendFileSync } from "node:fs";
const record = (entry) => appendFileSync(process.env.PI_IMPORT_GRAPH_LOG, JSON.stringify(entry) + "\\n");
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  record({ phase: "resolve", specifier, url: result.url });
  return result;
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  record({ phase: "load", url });
  return result;
}
`;

const registerSource = `
import { register } from "node:module";
register(new URL("./hook.mjs", import.meta.url));
`;

const driverSource = `
const before = new Set(Reflect.ownKeys(globalThis).map(String));
await import(process.argv[2]);
const globalsAdded = Reflect.ownKeys(globalThis).map(String).filter((key) => !before.has(key));
console.log(JSON.stringify({ globalsAdded }));
`;

function ensureBuiltDependencyLink(repoRoot: string): () => void {
	const link = join(repoRoot, "packages/coding-agent/node_modules/@earendil-works/pi-ai");
	mkdirSync(dirname(link), { recursive: true });
	try {
		symlinkSync(join(repoRoot, "packages/ai"), link, "dir");
		return () => rmSync(link, { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return () => {};
	}
}

export function probeModelRuntimeImport(repoRoot: string, target: "source" | "built"): ImportGraphProbeResult {
	const scratch = mkdtempSync(join(tmpdir(), "pi-model-runtime-import-"));
	const logPath = join(scratch, "graph.jsonl");
	writeFileSync(join(scratch, "hook.mjs"), hookSource);
	writeFileSync(join(scratch, "register.mjs"), registerSource);
	writeFileSync(join(scratch, "driver.mjs"), driverSource);
	const cleanupLink = ensureBuiltDependencyLink(repoRoot);
	try {
		const targetPath =
			target === "source"
				? join(repoRoot, "packages/coding-agent/src/core/model-runtime.ts")
				: join(repoRoot, "packages/coding-agent/dist/core/model-runtime.js");
		const args = ["--import", join(scratch, "register.mjs"), join(scratch, "driver.mjs"), resolve(targetPath)];
		const child = spawnSync(process.execPath, args, {
			cwd: repoRoot,
			env: { ...process.env, PI_IMPORT_GRAPH_LOG: logPath },
			encoding: "utf8",
		});
		if (child.status !== 0) throw new Error(`Import probe failed (${target}): ${child.stderr || child.stdout}`);
		const output = JSON.parse(child.stdout.trim()) as { globalsAdded: string[] };
		const entries = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ImportGraphProbeResult["entries"][number]);
		return { entries, globalsAdded: output.globalsAdded, stdout: child.stdout.trim() };
	} finally {
		cleanupLink();
		rmSync(scratch, { recursive: true, force: true });
	}
}

export const importGraphHookSource = hookSource;
