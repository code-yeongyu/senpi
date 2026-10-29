import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const kernelDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "kernels", "js");
const root = mkdtempSync(join(tmpdir(), "permission-bootstrap-engine-"));
const failures: string[] = [];
let passed = 0;

const rule = { permission: "write", pattern: "target", layer: "user" } as const;

function patch(file: string, from: string, to: string): void {
	const text = readFileSync(file, "utf8");
	assert.ok(text.includes(from), `mutation anchor missing in ${file}: ${from}`);
	writeFileSync(file, text.replace(from, to));
}

// The worker bootstrap and the engine hooks reach initializePermissionRuntime as two separate
// arguments. Dropping either one makes the bootstrap throw, and the kernel then falls back to the
// inline worker, which loads the unmutated modules: the refusals below still look correct there, so
// the mode is what tells a healthy handoff apart from a broken one.
async function probe(entry?: URL): Promise<Record<string, string>> {
	const dir = mkdtempSync(join(root, "row-"));
	const target = join(dir, "target");
	const allowed = join(dir, "allowed");
	writeFileSync(target, "{}");
	writeFileSync(allowed, "{}");
	const kernel = new JavaScriptKernel({
		sessionId: crypto.randomUUID(),
		cwd: dir,
		parallelPoolWidth: 2,
		...(entry ? { workerEntryUrl: entry } : {}),
		permissions: {
			checkDeadlineMs: 120_000,
			state: () => ({ epoch: 1, active: true, rules: [rule] }),
			decide: (_token, call) => (call.input.path === target ? { action: "deny", rule } : { action: "pass" }),
		},
	});
	const cell = async (code: string): Promise<string> => {
		const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 120_000 });
		return result.ok ? String(JSON.parse(result.valueRepr ?? '""')) : `CELLERR:${result.error?.code}`;
	};
	try {
		const deniedWrite = await cell(
			`try{require("node:fs").writeFileSync(${JSON.stringify(target)},"bad");return "wrote";}catch(error){return error?.code ?? error?.name ?? "none";}`,
		);
		const allowedWrite = await cell(
			`try{require("node:fs").writeFileSync(${JSON.stringify(allowed)},"ok");return "wrote";}catch(error){return error?.code ?? error?.name ?? "none";}`,
		);
		const preludeRead = await cell(
			`try{await read(${JSON.stringify(target)});return "read";}catch(error){return error?.code ?? error?.name ?? "none";}`,
		);
		const preludeWrite = await cell(
			`try{await write(${JSON.stringify(target)},"mutated");return "wrote";}catch(error){return error?.code ?? error?.name ?? "none";}`,
		);
		// require hands back only the port primitives a cell already owns as globals; the bindings that
		// would escape the interposition stay absent.
		const workerThreads = await cell(
			`const wt=require("node:worker_threads");return JSON.stringify([wt.Worker===undefined,wt.parentPort===undefined,wt.workerData===undefined,wt.MessageChannel===globalThis.MessageChannel]);`,
		);
		// Read after the cells: the kernel picks its mode when it starts, not when it is constructed.
		return { mode: kernel.mode, deniedWrite, allowedWrite, preludeRead, preludeWrite, workerThreads };
	} finally {
		await kernel.close();
	}
}

// Each mutation is a merge that kept one argument and lost the other.
const mutations = [
	{
		name: "engine hooks dropped from the handoff",
		apply: (dir: string) =>
			patch(
				join(dir, "interpose.js"),
				"}, bootstrap, {\n\tpermissionIO,\n\tresolverIO: originals,\n\tcleanupExecFile,\n\tactivate,\n\tinstallGuardedWorker,\n});",
				"}, bootstrap);",
			),
	},
	{
		name: "bootstrap dropped from the handoff",
		apply: (dir: string) => patch(join(dir, "interpose.js"), "}, bootstrap, {", "}, {"),
	},
] as const;

const expected = {
	mode: "worker",
	deniedWrite: "cell_permission_denied",
	allowedWrite: "wrote",
	preludeRead: "cell_permission_denied",
	preludeWrite: "cell_permission_denied",
	workerThreads: "[true,true,true,true]",
};

try {
	try {
		assert.deepEqual(await probe(), expected);
		passed++;
	} catch (error) {
		failures.push(`guarded: ${String(error)}`);
	}
	for (const mutation of mutations) {
		const dir = mkdtempSync(join(root, "mutant-"));
		cpSync(kernelDir, dir, { recursive: true });
		mutation.apply(dir);
		try {
			const result = await probe(pathToFileURL(join(dir, "worker-entry.js")));
			assert.notEqual(result.mode, "worker", `mutation kept the worker bootstrap: ${mutation.name}`);
			passed++;
		} catch (error) {
			failures.push(`mutated/${mutation.name}: ${String(error)}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures }));
process.exitCode = failures.length ? 1 : 0;
