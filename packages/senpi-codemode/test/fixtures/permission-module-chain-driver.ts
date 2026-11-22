import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import { createIdentityDecider, type RecordedCall } from "./path-identity.ts";

// Design 6.4 / 11.1.5: module resolution and module top-level bodies run outside the cell's async
// context, so they are decided under the importing cell's authority through a per-token loading
// window, fail-closed whenever more than one principal could own the operation.
const root = mkdtempSync(join(tmpdir(), "permission-module-chain-"));
const failures: string[] = [];
let passed = 0;
const secret = join(root, "secret.json");
const secretReal = join(realpathSync.native(root), "secret.json");
const allowedJson = join(root, "allowed.json");
const allowedTxt = join(root, "allowed.txt");
writeFileSync(secret, '{"secret":42}');
writeFileSync(allowedJson, '{"allowed":1}');
writeFileSync(allowedTxt, "allowed text");
writeFileSync(join(root, "outer.mjs"), "import data from './secret.json' with { type: 'json' };export default data;");
// One importer file per row: the runtime resolves a given importer's imports once, so a `?query`
// variant of an already-loaded importer never reaches the resolve hook again.
for (const name of ["outer2", "outer-h4", "outer-m8", "outer-n4"]) {
	writeFileSync(
		join(root, `${name}.mjs`),
		"import data from './allowed.json' with { type: 'json' };export default data;",
	);
}
writeFileSync(
	join(root, "toplevel.mjs"),
	"import { readFileSync } from 'node:fs';export default readFileSync('allowed.txt', 'utf8');",
);
writeFileSync(
	join(root, "deferred.mjs"),
	"import { readFileSync } from 'node:fs';globalThis.deferredRead = new Promise((ok) => setTimeout(() => { try { ok(readFileSync('allowed.txt', 'utf8')); } catch (error) { ok('refused:' + error.code); } }, 0));export default 1;",
);
writeFileSync(join(root, "slow.mjs"), "await globalThis.release.promise;export default 'slow';");

const pendingWindow = "globalThis[Symbol.for('senpi.kernel.permissionLoad')]?.pending?.() ?? -1";

try {
	for (const mode of ["worker", "inline"]) {
		const denied = new Set<string>([secret]);
		const calls: RecordedCall[] = [];
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: root,
			parallelPoolWidth: 2,
			...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "missing.js")) } : {}),
			permissions: {
				checkDeadlineMs: 120_000,
				state: () => ({
					active: true,
					epoch: 1,
					rules: [{ permission: "read", pattern: "boundary", layer: "user" }],
				}),
				decide: createIdentityDecider(denied, calls),
			},
		});
		const run = (code: string) => kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 20_000 });
		const row = async (name: string, check: () => Promise<void>) => {
			try {
				await check();
				const pending = await run(`return ${pendingWindow}`);
				assert.equal(
					pending.ok && pending.valueRepr,
					"0",
					`loading window not empty after the row: ${JSON.stringify(pending)}`,
				);
				passed++;
			} catch (error) {
				failures.push(`${mode}/${name}: ${String(error)}`);
			}
		};
		try {
			await row("outer2.mjs (allowed chain) loads under an active deny", async () => {
				const result = await run("return (await import('./outer2.mjs')).default.allowed");
				assert.equal(result.ok, true, JSON.stringify(result));
				assert.equal(result.valueRepr, "1");
			});
			await row("toplevel.mjs loads and its body read is decided", async () => {
				calls.length = 0;
				const result = await run("return (await import('./toplevel.mjs')).default");
				assert.equal(result.ok, true, JSON.stringify(result));
				assert.equal(result.valueRepr, '"allowed text"');
				assert.ok(
					calls.some((call) => call.tool === "read" && call.path === "allowed.txt"),
					JSON.stringify(calls),
				);
			});
			await row("outer.mjs (chain reaches the denied file) is refused by a host decision", async () => {
				calls.length = 0;
				const result = await run("return (await import('./outer.mjs')).default");
				assert.equal(!result.ok && result.error?.code === "cell_permission_denied", true, JSON.stringify(result));
				assert.ok(!result.ok && result.error?.message.startsWith("Operation denied"), JSON.stringify(result));
				assert.ok(
					calls.some(
						(call) => call.canonical === secretReal || call.executedPath === secret || call.path === secret,
					),
					JSON.stringify(calls),
				);
			});
			await row("a timer scheduled by a module body fires after the import settled: refused", async () => {
				const result = await run("await import('./deferred.mjs'); return await globalThis.deferredRead");
				assert.equal(result.ok, true, JSON.stringify(result));
				assert.equal(result.valueRepr, '"refused:cell_permission_denied"');
			});
			await row(
				"an inactive cell's deferred import during an active cell's import window is refused (H4)",
				async () => {
					const scheduled = await run(
						"globalThis.ready = Promise.withResolvers(); globalThis.ready.promise.then(() => { globalThis.outcome = import('./outer-h4.mjs').then(() => 'passed', (error) => error.code ?? String(error)).finally(() => globalThis.release?.resolve()); }); return 1",
					);
					assert.equal(scheduled.ok, true, JSON.stringify(scheduled));
					const result = await run(
						"globalThis.release = Promise.withResolvers(); const loading = import('./slow.mjs'); globalThis.ready.resolve(); await loading; return await globalThis.outcome",
					);
					assert.equal(result.ok, true, JSON.stringify(result));
					assert.equal(result.valueRepr, '"cell_permission_denied"');
				},
			);
			await row("a sole inactive loader while another token is active is refused (M8)", async () => {
				const scheduled = await run(
					"globalThis.ready = Promise.withResolvers(); globalThis.ready.promise.then(() => { globalThis.outcome = import('./outer-m8.mjs').then(() => 'passed', (error) => error.code ?? String(error)); }); return 1",
				);
				assert.equal(scheduled.ok, true, JSON.stringify(scheduled));
				const result = await run("globalThis.ready.resolve(); return await globalThis.outcome");
				assert.equal(result.ok, true, JSON.stringify(result));
				assert.equal(result.valueRepr, '"cell_permission_denied"');
			});
			await row(
				"a sole active loader while a second active token is bound but not loading is refused (N4)",
				async () => {
					const defined = await run(
						"globalThis.gate = Promise.withResolvers(); globalThis.started = Promise.withResolvers(); tool(async function hold() { globalThis.started.resolve(); await globalThis.gate.promise; return 'held'; }); return 1",
					);
					assert.equal(defined.ok, true, JSON.stringify(defined));
					const entry = (await kernel.describeKernelTools(["hold"])).results[0];
					if (!entry?.ok) throw new Error("missing hold descriptor");
					const held = kernel.invokeKernelTool({ ...entry.descriptor, args: {}, call_id: crypto.randomUUID() });
					calls.length = 0;
					const result = await run(
						"await globalThis.started.promise; const outcome = await import('./outer-n4.mjs').then(() => 'passed', (error) => error.code ?? String(error)); globalThis.gate.resolve(); return outcome",
					);
					assert.equal(result.ok, true, JSON.stringify(result));
					assert.equal(result.valueRepr, '"cell_permission_denied"');
					assert.ok(
						!calls.some((call) => call.path?.endsWith("allowed.json")),
						`nested import was decided: ${JSON.stringify(calls)}`,
					);
					await held;
				},
			);
		} finally {
			await kernel.close();
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures }));
process.exitCode = failures.length ? 1 : 0;
