import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { JavaScriptKernel, revokeSessionKernels } from "../src/kernels/js/context-manager.ts";
import { KernelPermissionHost } from "../src/kernels/js/permission-host.ts";
import { WorkerSlot } from "../src/kernels/js/worker-slot.ts";

// #4309: assert prevented effects at the real worker boundary, not a mocked authorizer.
describe.each(["worker", "inline"] as const)("eval permission core (%s)", (mode) => {
	it.each([true, false])("enforces only active deny rules (active=%s)", async (active) => {
		const root = await mkdtemp(join(tmpdir(), "eval-permissions-"));
		const denied = join(root, "denied");
		const marker = join(root, "spawned");
		const executable = join(root, "uname");
		await writeFile(executable, `#!/bin/sh\nprintf ran > '${marker}'\n`);
		await chmod(executable, 0o755);
		const library = join(root, "node_modules", "write-fixture");
		await mkdir(library, { recursive: true });
		await writeFile(join(library, "package.json"), '{"type":"module","main":"index.js"}');
		await writeFile(
			join(library, "index.js"),
			'import { writeFileSync } from "node:fs"; export function put(path) { writeFileSync(path, "library"); }',
		);
		const calls: unknown[] = [];
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: root,
			parallelPoolWidth: 2,
			...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "missing.js")) } : {}),
			permissions: {
				state: () => ({ active, epoch: 1, rules: [{ permission: "bash", pattern: "uname", layer: "user" }] }),
				decide: (_token, call) => {
					calls.push(call);
					return (call.tool === "bash" && call.input.command?.includes("uname")) || call.input.path === denied
						? { action: "deny", rule: { permission: call.tool, pattern: "fixture", layer: "user" } }
						: { action: "pass" };
				},
			},
		});
		const run = (code: string) => kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 8_000 });
		try {
			const spawn = await run(`require("node:child_process").spawnSync(${JSON.stringify(executable)});`);
			expect.soft(spawn.ok).toBe(!active);
			expect.soft(existsSync(marker)).toBe(!active);
			const write = await run(`require("node:fs").writeFileSync(${JSON.stringify(denied)}, "denied");`);
			expect.soft(write.ok).toBe(!active);
			expect.soft(existsSync(denied)).toBe(!active);
			const fromLibrary = await run(`import { put } from "write-fixture"; put(${JSON.stringify(denied)});`);
			expect.soft(fromLibrary.ok).toBe(!active);
			const allowed = join(root, "allowed");
			expect((await run(`require("node:fs").writeFileSync(${JSON.stringify(allowed)}, "ok");`)).ok).toBe(true);
			expect(await readFile(allowed, "utf8")).toBe("ok");
			expect(kernel.mode).toBe(mode);
			if (active) {
				expect(spawn).toMatchObject({
					error: {
						code: "cell_permission_denied",
						permissionRule: { permission: "bash", pattern: "fixture", layer: "user" },
					},
				});
				expect(write).toMatchObject({ error: { code: "cell_permission_denied" } });
				expect(calls.length).toBeGreaterThan(0);
			} else {
				expect(calls).toEqual([]);
			}
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("permission lifetime", () => {
	it.each(["absent", "inactive", "active"] as const)(
		"checks continuations after settlement with %s permissions",
		async (policy) => {
			const root = await mkdtemp(join(tmpdir(), "eval-continuation-"));
			const kernel = new JavaScriptKernel({
				sessionId: crypto.randomUUID(),
				cwd: root,
				parallelPoolWidth: 2,
				...(policy === "absent"
					? {}
					: {
							permissions: {
								state: () => ({ epoch: 1, active: policy === "active", rules: [] }),
								decide: () => ({ action: "pass" as const }),
							},
						}),
			});
			try {
				// A timed-out or interrupted cell ends its run like settlement does; its worker and globals survive.
				for (const [source, ending] of [
					["promise", "settled"],
					["message-port", "settled"],
					["promise", "timeout"],
					["promise", "interrupt"],
				] as const) {
					const path = join(root, `${source}-${ending}`);
					const setup =
						source === "promise"
							? `var gate = Promise.withResolvers(); var result = gate.promise.then(effect); var trigger = () => gate.resolve();`
							: `var channel = new (require("node:worker_threads").MessageChannel)();
						var result = new Promise(resolve => channel.port1.once("message", () => {
							resolve(effect()); channel.port1.close(); channel.port2.close();
						})); var trigger = () => channel.port2.postMessage(null);`;
					const first = kernel.run({
						cellId: crypto.randomUUID(),
						code: `
					var effect = () => { try { require("node:fs").writeFileSync(${JSON.stringify(path)}, "ok"); return "wrote"; }
						catch (error) { return error.code; } }; ${setup}
					${ending === "interrupt" ? "await tool.parked({});" : ""}
					${ending === "settled" ? "" : "await new Promise(() => {});"}
				`,
						timeoutMs: ending === "timeout" ? 500 : 8_000,
					});
					if (ending === "interrupt") {
						await kernel.nextToolCall();
						await kernel.interrupt("continuation interrupt");
					}
					expect(await first).toMatchObject({ ok: ending === "settled" });
					expect(
						await kernel.run({
							cellId: crypto.randomUUID(),
							code: "trigger(); return await result;",
							timeoutMs: 8_000,
						}),
					).toMatchObject({
						ok: true,
						valueRepr: JSON.stringify(policy === "active" ? "cell_permission_denied" : "wrote"),
					});
					expect(existsSync(path)).toBe(policy !== "active");
				}
			} finally {
				await kernel.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("bounds a held host decision and interrupts a parked check", async () => {
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<{ action: "pass" }>();
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			permissions: {
				state: () => ({ epoch: 1, active: true, rules: [] }),
				decide: () => {
					requested.resolve();
					return answer.promise;
				},
			},
		});
		try {
			const run = kernel.run({
				cellId: "parked",
				code: 'require("node:child_process").spawnSync("uname")',
				timeoutMs: 8_000,
			});
			await requested.promise;
			await kernel.interrupt("permission interrupt");
			expect(await run).toMatchObject({ ok: false });
			const deadline = await kernel.run({
				cellId: "deadline",
				code: 'require("node:child_process").spawnSync("uname")',
				timeoutMs: 8_000,
			});
			expect(deadline).toMatchObject({ ok: false, error: { code: "cell_permission_denied" } });
			expect(deadline.durationMs).toBeGreaterThanOrEqual(1_900);
		} finally {
			answer.resolve({ action: "pass" });
			await kernel.close();
		}
	});

	it("revokes immediately and admits the replacement only after retirement", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-revoke-"));
		const sessionId = crypto.randomUUID();
		const kernel = new JavaScriptKernel({ sessionId, cwd: root, parallelPoolWidth: 2 });
		const reachedRetirement = Promise.withResolvers<void>();
		const finishRetirement = Promise.withResolvers<void>();
		const original = WorkerSlot.prototype.retire;
		const held = vi.spyOn(WorkerSlot.prototype, "retire").mockImplementationOnce(async function (this: WorkerSlot) {
			reachedRetirement.resolve();
			await finishRetirement.promise;
			return await original.call(this);
		});
		try {
			const running = kernel.run({
				cellId: "old",
				timeoutMs: 8_000,
				code: `await tool.ready({}); try { require("node:fs").writeFileSync("late", "bad"); } catch (e) { await tool.refused({code:e.code}); }`,
			});
			const ready = await kernel.nextToolCall();
			const revoked = revokeSessionKernels(sessionId);
			await reachedRetirement.promise;
			let replacementSettled = false;
			const replacement = kernel.run({ cellId: "new", code: "return 42", timeoutMs: 8_000 }).then((result) => {
				replacementSettled = true;
				return result;
			});
			kernel.deliverToolReply({ type: "tool-reply", callId: ready.callId, ok: true, value: null });
			const refusal = await kernel.nextToolCall();
			expect(refusal).toMatchObject({ toolName: "refused", args: { code: "cell_permission_denied" } });
			expect(existsSync(join(root, "late"))).toBe(false);
			expect(replacementSettled).toBe(false);
			finishRetirement.resolve();
			await revoked;
			expect(await running).toMatchObject({ ok: false });
			expect(await replacement).toMatchObject({ ok: true, valueRepr: "42" });
		} finally {
			finishRetirement.resolve();
			held.mockRestore();
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports abandoned retirement once and permanently fences the session", async () => {
		const sessionId = crypto.randomUUID();
		const failed = vi.fn();
		const kernel = new JavaScriptKernel({
			sessionId,
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			onRevocationFailed: failed,
			interruptBounds: { ackMs: 10, graceMs: 10, terminateDeadlineMs: 1 },
		});
		await kernel.run({ cellId: "ready", code: "return 1" });
		const release = Promise.withResolvers<void>();
		const terminate = KernelPermissionHost.prototype.terminateChildren;
		const held = vi.spyOn(KernelPermissionHost.prototype, "terminateChildren").mockImplementationOnce(async function (
			this: KernelPermissionHost,
		) {
			await release.promise;
			await terminate.call(this);
		});
		vi.useFakeTimers();
		try {
			const revoked = revokeSessionKernels(sessionId);
			await vi.advanceTimersByTimeAsync(1);
			await revoked;
			expect(failed).toHaveBeenCalledTimes(1);
			expect(failed).toHaveBeenCalledWith({ sessionId, kernelId: expect.any(String) });
			await expect(kernel.run({ cellId: "refused", code: "return 2" })).rejects.toThrow();
			const another = new JavaScriptKernel({ sessionId, cwd: process.cwd(), parallelPoolWidth: 2 });
			try {
				await expect(another.run({ cellId: "also-refused", code: "return 3" })).rejects.toThrow();
			} finally {
				await another.close();
			}
		} finally {
			vi.useRealTimers();
			release.resolve();
			held.mockRestore();
			await kernel.close();
		}
	});

	it("keeps concurrent invocation tokens distinct across awaits", async () => {
		const seen: { token: string; path?: string }[] = [];
		const kernel = new JavaScriptKernel({
			sessionId: crypto.randomUUID(),
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			permissions: {
				state: () => ({ active: true, epoch: 1, rules: [] }),
				decide: (token, call) => {
					seen.push({ token: token.id, path: call.input.path });
					return { action: "deny", rule: { permission: "write", pattern: "*", layer: "user" } };
				},
			},
		});
		try {
			const parent = kernel.run({
				cellId: "parent",
				timeoutMs: 8_000,
				code: `tool(async function probe(path) {
					for (let i=0;i<2;i++) { try { require("node:fs").writeFileSync(path,"bad"); } catch {} await tool.barrier({path,i}); }
					return path;
				}); await tool.parent({});`,
			});
			const parentCall = await kernel.nextToolCall();
			const description = (await kernel.describeKernelTools(["probe"])).results[0];
			if (!description.ok) throw new Error("missing descriptor");
			const descriptor = description.descriptor;
			const invoke = (path: string) =>
				kernel.invokeKernelTool({
					name: "probe",
					args: { path },
					call_id: path,
					kernel_generation: descriptor.kernel_generation,
					definition_revision: descriptor.definition_revision,
				});
			const first = invoke("first");
			const second = invoke("second");
			for (let round = 0; round < 2; round++) {
				const calls = [await kernel.nextToolCall(), await kernel.nextToolCall()];
				for (const call of calls)
					kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: null });
			}
			expect(await Promise.all([first, second])).toEqual(["first", "second"]);
			const a = seen.filter((row) => row.path === "first").map((row) => row.token);
			const b = seen.filter((row) => row.path === "second").map((row) => row.token);
			expect(a).toHaveLength(2);
			expect(b).toHaveLength(2);
			expect(new Set(a).size).toBe(1);
			expect(new Set(b).size).toBe(1);
			expect(a[0]).not.toBe(b[0]);
			kernel.deliverToolReply({ type: "tool-reply", callId: parentCall.callId, ok: true, value: null });
			await parent;
		} finally {
			await kernel.close();
		}
	});
});
