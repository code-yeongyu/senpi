import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import { type SinkMutationRow, sinkMutations } from "./permission-sink-mutation-rows.ts";

const kernelDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "kernels", "js");

const root = mkdtempSync(join(tmpdir(), "permission-sink-mutations-"));
const failures: string[] = [];
let passed = 0;

function mutate(sink: string): URL {
	const dir = mkdtempSync(join(root, "mutant-"));
	cpSync(kernelDir, dir, { recursive: true });
	// The copied interposition imports the shared path-identity module through `../shared/`.
	cpSync(join(kernelDir, "..", "shared", "path-identity.mjs"), join(root, "shared", "path-identity.mjs"));
	for (const file of ["interpose-bun.js", "interpose-process.js"]) {
		const path = join(dir, file);
		const kept = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => !line.includes(`// sink:${sink}`));
		writeFileSync(path, kept.join("\n"));
	}
	return pathToFileURL(join(dir, "worker-entry.js"));
}

const rules = [
	{ permission: "read", pattern: "target", layer: "user" },
	{ permission: "write", pattern: "target", layer: "user" },
] as const;
let denied: { tool: string; path: string; rule: (typeof rules)[number] } = {
	tool: "read",
	path: "",
	rule: rules[0],
};

function openKernel(cwd: string, workerEntryUrl?: URL) {
	return new JavaScriptKernel({
		sessionId: crypto.randomUUID(),
		cwd,
		parallelPoolWidth: 2,
		...(workerEntryUrl ? { workerEntryUrl } : {}),
		permissions: {
			checkDeadlineMs: 120_000,
			state: () => ({ epoch: 1, active: true, rules: [...rules] }),
			decide: (_token, call) =>
				call.tool === denied.tool && call.input.path === denied.path
					? { action: "deny", rule: denied.rule }
					: { action: "pass" },
		},
	});
}

async function run(kernel: JavaScriptKernel, row: SinkMutationRow) {
	const dir = mkdtempSync(join(root, "row-"));
	const p = join(dir, "target");
	const q = join(dir, "source");
	writeFileSync(p, "{}");
	writeFileSync(q, "{}");
	denied = { tool: row.tool, path: p, rule: row.tool === "read" ? rules[0] : rules[1] };
	return await kernel.run({
		cellId: crypto.randomUUID(),
		code: `const p=${JSON.stringify(p)},q=${JSON.stringify(q)};${row.code}`,
		timeoutMs: 120_000,
	});
}

const bashRule = { permission: "bash", pattern: "command", layer: "user" } as const;
const writeRule = { permission: "write", pattern: "target", layer: "user" } as const;
const ordering = [
	{ delay: "bash", denyCommand: true, expected: bashRule },
	{ delay: "write", denyCommand: true, expected: bashRule },
	{ delay: "bash", denyCommand: false, expected: writeRule },
	{ delay: "write", denyCommand: false, expected: writeRule },
] as const;

const deadlinePaths = [{ path: "worker" }, { path: "inline" }, { path: "nested-worker" }] as const;
const importShapes = [
	{
		shape: "dynamic import",
		file: "mod.mjs",
		source: 'export const value = "ok";',
		cell: (file: string) => `const m=await import(${JSON.stringify(file)});return m.value;`,
		expected: "ok",
		// The cell's import guard decides the specifier, then the resolver hook decides the resolved
		// target. Two routes, one answer each, no recursion.
		decisions: 2,
	},
	{
		shape: "require",
		file: "mod.cjs",
		source: 'module.exports = "ok";',
		cell: (file: string) => `return require(${JSON.stringify(file)});`,
		expected: "ok",
		// The cell's createRequire wrapper and the module require it delegates to each decide, and the
		// resolver hook decides once per resolution those two perform.
		decisions: 4,
	},
	{
		shape: "nested worker",
		file: "child.js",
		source: 'onmessage = () => postMessage("ok");\npostMessage("ready");',
		// A worker script is resolved once, by the resolver hook, when the child imports it.
		decisions: 1,
		cell: (file: string) =>
			`const w=new Worker(${JSON.stringify(pathToFileURL(file).href)});\nconst bounded=(label)=>new Promise((resolve)=>setTimeout(()=>resolve("TIMED OUT waiting for the nested worker to "+label),20000));\ntry{\n\tconst ready=await Promise.race([new Promise((resolve,reject)=>{w.onmessage=()=>resolve("ready");w.onerror=(event)=>reject(new Error("nested worker failed: "+event.message));}),bounded("start")]);\n\tif(ready!=="ready")return ready;\n\tconst answered=new Promise((resolve)=>{w.onmessage=(event)=>resolve(event.data);});\n\tw.postMessage("go");\n\treturn await Promise.race([answered,bounded("answer")]);\n}finally{w.terminate();}`,
		expected: "ok",
	},
] as const;

const shared = openKernel(root);
try {
	for (const row of sinkMutations) {
		const label = "label" in row ? row.label : `${row.sink}${"expect" in row ? "/copy" : ""}`;
		const mutantEntry = mutate(row.sink);
		const mutant = openKernel(root, mutantEntry);
		try {
			const guarded = await run(shared, row);
			const mutated = await run(mutant, row);
			if (row.guarded === "refused") {
				assert.equal(guarded.ok, false, `guarded: ${JSON.stringify(guarded)}`);
				assert.equal(guarded.ok ? undefined : guarded.error?.code, "cell_permission_denied");
				assert.equal(mutated.ok, true, `mutated: ${JSON.stringify(mutated)}`);
			} else if ("expect" in row) {
				assert.equal(guarded.ok, true, `guarded: ${JSON.stringify(guarded)}`);
				assert.equal(guarded.ok ? guarded.valueRepr : "", JSON.stringify(row.expect));
				assert.notEqual(mutated.ok ? mutated.valueRepr : "", JSON.stringify(row.expect));
			} else {
				assert.equal(guarded.ok, true, `guarded: ${JSON.stringify(guarded)}`);
				assert.equal(mutated.ok, false, `mutated: ${JSON.stringify(mutated)}`);
			}
			passed++;
		} catch (error) {
			failures.push(`${label}: ${String(error)}`);
		} finally {
			await mutant.close();
			rmSync(dirname(fileURLToPath(mutantEntry)), { recursive: true, force: true });
		}
	}
	for (const row of ordering) {
		const dir = mkdtempSync(join(root, "order-"));
		const target = join(dir, "target");
		const command = join(dir, "command");
		writeFileSync(target, "{}");
		writeFileSync(command, "#!/bin/sh\nprintf ran\n");
		chmodSync(command, 0o755);
		// rules[0] is the write rule on purpose: a refusal that falls back to it instead of naming the
		// decision that actually denied would report the wrong rule, which is the defect under test.
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: dir,
			parallelPoolWidth: 2,
			permissions: {
				checkDeadlineMs: 120_000,
				state: () => ({ epoch: 1, active: true, rules: [writeRule, bashRule] }),
				decide: async (_token, call) => {
					if (call.tool === row.delay) await new Promise((resolve) => setTimeout(resolve, 150));
					if (call.tool === "bash" && call.input.command?.includes(command)) {
						return row.denyCommand ? { action: "deny", rule: bashRule } : { action: "pass" };
					}
					if (call.tool === "write" && call.input.path === target) return { action: "deny", rule: writeRule };
					return { action: "pass" };
				},
			},
		});
		try {
			const result = await kernel.run({
				cellId: crypto.randomUUID(),
				code: `return String(await Bun.spawn({cmd:[${JSON.stringify(command)}],stdout:Bun.file(${JSON.stringify(target)})}).exited);`,
				timeoutMs: 120_000,
			});
			assert.equal(result.ok, false, `ordering: ${JSON.stringify(result)}`);
			assert.equal(result.ok ? undefined : result.error?.code, "cell_permission_denied");
			assert.deepEqual(result.ok ? undefined : result.error?.permissionRule, row.expected);
			passed++;
		} catch (error) {
			failures.push(`ordering/delay-${row.delay}/${row.denyCommand ? "command" : "stdout"}: ${String(error)}`);
		} finally {
			await kernel.close();
		}
	}

	for (const row of deadlinePaths) {
		const dir = mkdtempSync(join(root, "deadline-"));
		const target = join(dir, "target");
		const child = join(dir, "child.js");
		writeFileSync(target, "{}");
		writeFileSync(
			child,
			`onmessage = async () => { try { postMessage(await Bun.file(${JSON.stringify(target)}).text()); } catch (error) { postMessage("ERROR " + (error?.code ?? error?.message)); } };\npostMessage("ready");`,
		);
		// The decider answers after 3s: longer than the 2s production default, well inside the configured
		// deadline. A path that never received the configured value fails here instead of reading the file.
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: dir,
			parallelPoolWidth: 2,
			...(row.path === "inline" ? { workerEntryUrl: pathToFileURL(join(dir, "absent.js")) } : {}),
			permissions: {
				checkDeadlineMs: 60_000,
				state: () => ({ epoch: 1, active: true, rules: [...rules] }),
				// Only the read under test waits: spawning a nested worker resolves its script thousands of
				// times, and delaying every one of those would outlast any deadline.
				decide: async (_token, call) => {
					if (call.input.path === target) await new Promise((resolve) => setTimeout(resolve, 3_000));
					return { action: "pass" };
				},
			},
		});
		try {
			const result = await kernel.run({
				cellId: crypto.randomUUID(),
				code:
					row.path === "nested-worker"
						? `const w=new Worker(${JSON.stringify(pathToFileURL(child).href)});
const bounded=(label)=>new Promise((resolve)=>setTimeout(()=>resolve("TIMED OUT waiting for the nested worker to "+label),20000));
try{
	const ready=await Promise.race([new Promise((resolve,reject)=>{w.onmessage=()=>resolve("ready");w.onerror=(event)=>reject(new Error("nested worker failed: "+event.message));}),bounded("start")]);
	if(ready!=="ready")return ready;
	const answered=new Promise((resolve)=>{w.onmessage=(event)=>resolve(event.data);});
	w.postMessage("read");
	return await Promise.race([answered,bounded("answer")]);
}finally{w.terminate();}`
						: `return await Bun.file(${JSON.stringify(target)}).text();`,
				timeoutMs: 120_000,
			});
			assert.equal(result.ok, true, `deadline/${row.path}: ${JSON.stringify(result)}`);
			assert.equal(result.ok ? result.valueRepr : "", JSON.stringify("{}"));
			passed++;
		} catch (error) {
			failures.push(`deadline-reaches/${row.path}: ${String(error)}`);
		} finally {
			await kernel.close();
		}
	}
	for (const mode of ["worker", "inline"] as const) {
		for (const shape of importShapes) {
			const dir = mkdtempSync(join(root, "import-"));
			const file = join(dir, shape.file);
			writeFileSync(file, shape.source);
			const counts = new Map<string, number>();
			const kernel = new JavaScriptKernel({
				sessionId: crypto.randomUUID(),
				cwd: dir,
				parallelPoolWidth: 2,
				...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(dir, "absent.js")) } : {}),
				permissions: {
					checkDeadlineMs: 120_000,
					state: () => ({ epoch: 1, active: true, rules: [...rules] }),
					decide: (_token, call) => {
						if (call.input.path) counts.set(call.input.path, (counts.get(call.input.path) ?? 0) + 1);
						return { action: "pass" };
					},
				},
			});
			try {
				const result = await kernel.run({
					cellId: crypto.randomUUID(),
					code: shape.cell(file),
					timeoutMs: 120_000,
				});
				assert.equal(result.ok, true, `${mode}/${shape.shape}: ${JSON.stringify(result)}`);
				assert.equal(result.ok ? result.valueRepr : "", JSON.stringify(shape.expected));
				// Each route decides once with the same rule and the same answer; resolving re-enters the
				// observed resolver, and that re-entry is the same import rather than a new one.
				assert.equal(
					counts.get(file) ?? 0,
					shape.decisions,
					`${mode}/${shape.shape}: ${counts.get(file) ?? 0} decisions, expected ${shape.decisions}`,
				);
				passed++;
			} catch (error) {
				failures.push(`import-decisions/${mode}/${shape.shape}: ${String(error)}`);
			} finally {
				await kernel.close();
			}
		}
	}
} finally {
	await shared.close();
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures }));
process.exitCode = failures.length ? 1 : 0;
