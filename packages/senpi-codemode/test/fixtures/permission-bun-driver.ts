import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel, revokeSessionKernels } from "../../src/kernels/js/context-manager.ts";
import { WorkerSlot } from "../../src/kernels/js/worker-slot.ts";

const root = await mkdtemp(join(tmpdir(), "permission-bun-"));
try {
	const executable = join(root, "uname");
	const marker = join(root, "spawn-marker");
	await writeFile(executable, `#!/bin/sh\nprintf ran > '${marker}'\n`);
	await chmod(executable, 0o755);
	const library = join(root, "node_modules", "write-fixture");
	await mkdir(library, { recursive: true });
	await writeFile(join(library, "package.json"), '{"type":"module","main":"index.js"}');
	await writeFile(
		join(library, "index.js"),
		'import {writeFileSync} from "node:fs"; export const put=(p)=>writeFileSync(p,"bad");',
	);
	for (const mode of ["worker", "inline"]) {
		for (const active of [true, false]) {
			const denied = join(root, `denied-${mode}-${active}`);
			const kernel = new JavaScriptKernel({
				sessionId: crypto.randomUUID(),
				cwd: root,
				parallelPoolWidth: 2,
				...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "absent.js")) } : {}),
				permissions: {
					state: () => ({ epoch: 1, active, rules: [{ permission: "bash", pattern: "uname", layer: "user" }] }),
					decide: (_token, call) =>
						call.tool === "bash" || call.input.path === denied
							? { action: "deny", rule: { permission: call.tool, pattern: "fixture", layer: "user" } }
							: { action: "pass" },
				},
			});
			try {
				await rm(marker, { force: true });
				for (const code of [
					`Bun.spawnSync([${JSON.stringify(executable)}]);`,
					`require("node:child_process").spawnSync(${JSON.stringify(executable)});`,
					`require("node:fs").writeFileSync(${JSON.stringify(denied)}, "bad");`,
					`import {put} from "write-fixture"; put(${JSON.stringify(denied)});`,
				]) {
					const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 8_000 });
					assert.equal(result.ok, !active, JSON.stringify(result));
				}
				assert.equal(existsSync(marker), !active);
				assert.equal(existsSync(denied), !active);
				assert.equal(kernel.mode, mode);
				const preload = join(root, `preload-${mode}-${active}.mjs`);
				const script = join(root, `script-${mode}-${active}.mjs`);
				await writeFile(
					preload,
					`import {writeFileSync} from "node:fs";
					try { writeFileSync(${JSON.stringify(denied)},"preload"); globalThis.preloadResult="wrote"; }
					catch(e) { globalThis.preloadResult=e.code; }`,
				);
				await writeFile(script, "postMessage(globalThis.preloadResult)");
				const worker = await kernel.run({
					cellId: crypto.randomUUID(),
					timeoutMs: 8_000,
					code: `
					const w=new Worker(${JSON.stringify(pathToFileURL(script).href)}, {preload:[${JSON.stringify(pathToFileURL(preload).href)}]});
					const result=await new Promise((resolve,reject)=>{w.onmessage=e=>resolve(e.data);w.onerror=reject});
					w.terminate(); return result;
				`,
				});
				assert.deepEqual(
					worker.ok && worker.valueRepr,
					JSON.stringify(active ? "cell_permission_denied" : "wrote"),
				);
				assert.equal(existsSync(denied), !active);
			} finally {
				await kernel.close();
			}
		}
	}

	const workerFile = join(root, "child.mjs");
	const childMarker = join(root, "child-marker");
	const nestedFile = join(root, "nested.mjs");
	const nestedMarker = join(root, "nested-marker");
	await writeFile(
		nestedFile,
		`
		import {writeFileSync} from "node:fs";
		onmessage=()=>{ try { writeFileSync(${JSON.stringify(nestedMarker)},"bad"); postMessage("wrote"); }
			catch(e) { postMessage(e.code); } };
		postMessage("ready");
	`,
	);
	await writeFile(
		workerFile,
		`
		import {writeFileSync} from "node:fs";
		const nested = new Worker(${JSON.stringify(pathToFileURL(nestedFile).href)});
		nested.onmessage=()=>postMessage("ready");
		onmessage=async (event)=>{
			if(event.data instanceof ArrayBuffer) { postMessage(event.data, [event.data]); return; }
			let own;
			try { writeFileSync(${JSON.stringify(childMarker)},"bad"); own="wrote"; }
			catch(e) { own=e.code; }
			const result=new Promise(resolve=>nested.onmessage=e=>resolve(e.data));
			nested.postMessage("write");
			postMessage([own,await result]);
		};
	`,
	);
	const sessionId = crypto.randomUUID();
	const kernel = new JavaScriptKernel({ sessionId, cwd: root, parallelPoolWidth: 2 });
	const original = WorkerSlot.prototype.retire;
	const reached = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	WorkerSlot.prototype.retire = async function () {
		reached.resolve();
		await finish.promise;
		return await original.call(this);
	};
	try {
		const run = kernel.run({
			cellId: "worker-owner",
			timeoutMs: 8_000,
			code: `
			const child = new Worker(${JSON.stringify(pathToFileURL(workerFile).href)});
			await new Promise((resolve,reject)=>{child.onmessage=resolve;child.onerror=reject});
			const bytes=new Uint8Array([42]).buffer;
			const echo=new Promise(resolve=>child.onmessage=e=>resolve(e.data));
			child.postMessage(bytes, [bytes]);
			await tool.ready({detached:bytes.byteLength, echoed:new Uint8Array(await echo)[0]});
			const result = new Promise((resolve)=>child.onmessage=(e)=>resolve(e.data));
			child.postMessage("write");
			await tool.refused({code:await result});
		`,
		});
		const ready = await kernel.nextToolCall();
		assert.deepEqual(ready.args, { detached: 0, echoed: 42 });
		const revoking = revokeSessionKernels(sessionId);
		await reached.promise;
		kernel.deliverToolReply({ type: "tool-reply", callId: ready.callId, ok: true, value: null });
		const refused = await kernel.nextToolCall();
		assert.deepEqual(refused.args, { code: ["cell_permission_denied", "cell_permission_denied"] });
		assert.equal(existsSync(childMarker), false);
		assert.equal(existsSync(nestedMarker), false);
		finish.resolve();
		await revoking;
		await run;
	} finally {
		finish.resolve();
		WorkerSlot.prototype.retire = original;
		await kernel.close();
	}
	console.log(JSON.stringify({ ok: true, modes: 2, activeStates: 2, nestedRevocation: true }));
} finally {
	await rm(root, { recursive: true, force: true });
}
