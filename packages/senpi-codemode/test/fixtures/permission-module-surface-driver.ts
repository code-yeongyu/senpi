import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import type { CellDecider, CellPermissionState } from "../../src/kernels/js/kernel-contract.ts";

const root = mkdtempSync(join(tmpdir(), "permission-module-surface-"));
const failures: string[] = [];
let passed = 0;

// The engine's own view of the module, measured in this process: a cell that is not being enforced
// must see exactly this, not a narrowed stand-in.
const native = process.getBuiltinModule("node:worker_threads");
const nativeKeys = Object.keys(native).sort().join(",");

// isMainThread is read by type, not by value: a cell runs on a worker thread and this driver does not.
// The constructor is proven native by behaviour, since only the engine's own Worker takes eval:true
// and is an emitter with a numeric threadId; a typeof check passes for any stand-in.
const surface = `const wt=require("node:worker_threads");
const w=new wt.Worker("require('node:worker_threads').parentPort.postMessage(42)",{eval:true});
const answer=await new Promise((resolve)=>w.once("message",resolve));
const threadId=typeof w.threadId;
await w.terminate();
return JSON.stringify([answer, threadId, typeof wt.isMainThread, typeof wt.receiveMessageOnPort, Object.keys(wt).sort().join(",")]);`;
const reduced = `const wt=require("node:worker_threads");
return JSON.stringify([wt.Worker===undefined, wt.parentPort===undefined, wt.workerData===undefined, wt.MessageChannel===globalThis.MessageChannel]);`;
const imported = `try{await import("node:worker_threads");return "loaded";}catch(error){return error?.code ?? error?.name ?? "none";}`;

const states: { readonly row: string; readonly state?: CellPermissionState }[] = [
	{ row: "no permissions" },
	{ row: "inactive", state: { epoch: 1, active: false, rules: [] } },
	{
		row: "active deny",
		state: { epoch: 1, active: true, rules: [{ permission: "write", pattern: "*", layer: "user" }] },
	},
];

const writeDeny = { permission: "write", pattern: "*", layer: "user" } as const;

async function run(
	state: CellPermissionState | undefined,
	code: string,
	decide: CellDecider = () => ({ action: "pass" }),
): Promise<string> {
	const dir = mkdtempSync(join(root, "row-"));
	const kernel = new JavaScriptKernel({
		sessionId: crypto.randomUUID(),
		cwd: dir,
		parallelPoolWidth: 2,
		...(state
			? {
					permissions: {
						checkDeadlineMs: 120_000,
						state: () => state,
						decide,
					},
				}
			: {}),
	});
	try {
		const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 120_000 });
		return result.ok ? String(JSON.parse(result.valueRepr ?? '""')) : `CELLERR:${result.error?.code}`;
	} finally {
		await kernel.close();
	}
}

const expect = async (row: string, actual: Promise<string>, want: string) => {
	try {
		assert.equal(await actual, want);
		passed++;
	} catch (error) {
		failures.push(`${row}: ${String(error)}`);
	}
};

// The cell starts a worker, says "go", and returns the worker's first reply as JSON.
async function startUserWorker(
	state: CellPermissionState | undefined,
	script: string,
	decide?: CellDecider,
): Promise<string> {
	const child = join(mkdtempSync(join(root, "user-worker-")), "child.mjs");
	writeFileSync(child, script);
	return await run(
		state,
		`const child=new Worker(${JSON.stringify(pathToFileURL(child).href)},{workerData:"payload"});
try{
	const reply=new Promise((resolve,reject)=>{child.onmessage=(event)=>resolve(event.data);child.onerror=(event)=>reject(new Error(event.message));});
	child.postMessage("go");
	return JSON.stringify(await reply);
}finally{child.terminate();}`,
		decide,
	);
}

// A cell's own worker reaches its own workerData and parentPort through this module (#4387), and the
// constructor it finds there, by require and by import, is the guarded one. Two routes prove it.
// At module top level no cell token is bound, so the guarded constructor refuses before any thread
// starts. Inside a message handler the worker's token is bound, the grandchild does start, and the
// write the rule denies is refused inside it. Deleting the constructor must not hand back the raw one.
async function userWorkerView(): Promise<string> {
	const dir = mkdtempSync(join(root, "user-worker-view-"));
	const denied = join(dir, "denied.txt");
	const grandchild = join(dir, "grandchild.js");
	writeFileSync(
		grandchild,
		`try { require("node:fs").writeFileSync(${JSON.stringify(denied)}, "x"); postMessage("wrote"); }
catch (error) { postMessage(error?.code ?? error?.name); }`,
	);
	const deny: CellDecider = (_token, call) =>
		call.input.path === denied ? { action: "deny", rule: writeDeny } : { action: "pass" };
	const reply = await startUserWorker(
		{ epoch: 1, active: true, rules: [writeDeny] },
		`const wt = require("node:worker_threads");
const ns = await import("node:worker_threads");
const startGrandchild = async () => {
	try {
		const w = new ns.Worker(${JSON.stringify(grandchild)});
		const answer = await new Promise((resolve) => { w.onmessage = (event) => resolve(event.data); w.onerror = (event) => resolve(event.message); });
		w.terminate();
		return answer;
	} catch (error) { return "refused:" + (error?.code ?? error?.name); }
};
const topLevel = await startGrandchild();
onmessage = async () => {
	const fromHandler = await startGrandchild();
	let deleted;
	try { deleted = delete wt.Worker; } catch { deleted = false; }
	postMessage([ns.workerData, ns.parentPort !== undefined, wt.Worker === globalThis.Worker, ns.Worker === globalThis.Worker,
		topLevel, fromHandler, deleted, require("node:worker_threads").Worker === globalThis.Worker]);
};`,
		deny,
	);
	return `${reply} written=${existsSync(denied)}`;
}

// A worker started while nothing is enforced keeps the engine's own Worker on the module, by require
// and by import: it runs eval code, is an emitter, has a numeric threadId, and is not the guarded global.
const nativeUserWorker = `const wt = require("node:worker_threads");
const ns = await import("node:worker_threads");
const w = new wt.Worker("require('node:worker_threads').parentPort.postMessage(7)", { eval: true });
const answer = await new Promise((resolve) => w.once("message", resolve));
const threadId = typeof w.threadId;
await w.terminate();
postMessage([answer, threadId, wt.Worker === globalThis.Worker, ns.Worker === wt.Worker]);`;

try {
	await expect(
		"user worker/own view",
		userWorkerView(),
		`${JSON.stringify(["payload", true, true, true, "refused:cell_permission_denied", "cell_permission_denied", false, true])} written=false`,
	);
	for (const { row, state } of states) {
		const enforced = state?.active === true;
		if (!enforced) {
			await expect(
				`${row}/user worker`,
				startUserWorker(state, nativeUserWorker),
				JSON.stringify([7, "number", false, true]),
			);
		}
		if (enforced) {
			// Enforcement is on: the escaping bindings are gone and only the port primitives the cell
			// already owns as globals remain.
			await expect(`${row}/require`, run(state, reduced), JSON.stringify([true, true, true, true]));
			await expect(`${row}/import`, run(state, imported), "cell_permission_denied");
		} else {
			// Nothing is enforced, so the cell must see the engine's own module, export for export.
			await expect(
				`${row}/require`,
				run(state, surface),
				JSON.stringify([42, "number", "boolean", "function", nativeKeys]),
			);
			await expect(`${row}/import`, run(state, imported), "loaded");
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures, nativeExports: Object.keys(native).length }));
process.exitCode = failures.length ? 1 : 0;
