// senpi#3566 todo 7: what each reverse-call kind reaches on the server.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FilesystemPolicyChecker } from "../src/core/extensions/types.ts";
import { createSessionHostCallHandler, type HostCallTarget } from "../src/core/tool-child-host-calls.ts";
import type { HostCallRequest } from "../src/modes/rpc/tool-child/host-calls-server.ts";

function request(overrides: Partial<HostCallRequest>): HostCallRequest {
	return {
		callId: "c1",
		jobId: "j1",
		kind: "tool",
		name: undefined,
		args: null,
		signal: new AbortController().signal,
		context: undefined,
		generation: { exited: new Promise(() => {}), jobLive: () => true },
		...overrides,
	};
}

describe("session host-call handler", () => {
	const unreachable = () => Promise.reject(new Error("not reached"));

	it("refuses a tool call from a job that runs for no tool call", async () => {
		const handler = createSessionHostCallHandler({
			cwd: process.cwd(),
			executeNested: unreachable,
			callableToolNames: () => [],
			target: () => undefined,
			filesystemPolicy: () => undefined,
		});
		await expect(handler(request({ kind: "tool", name: "todo" }))).rejects.toMatchObject({
			code: "host_call_no_caller",
		});
	});

	it("lists the callable tools", async () => {
		const handler = createSessionHostCallHandler({
			cwd: process.cwd(),
			executeNested: unreachable,
			callableToolNames: () => ["read", "todo"],
			target: () => undefined,
			filesystemPolicy: () => undefined,
		});
		expect(await handler(request({ kind: "list_tools" }))).toEqual(["read", "todo"]);
	});

	it("refuses completion and reserved typed when no target is registered, and routes to a registered one", async () => {
		const seen: unknown[] = [];
		const reserved: HostCallTarget = async (call) => {
			seen.push(call);
			return { served: call.name };
		};
		const handler = createSessionHostCallHandler({
			cwd: process.cwd(),
			executeNested: unreachable,
			callableToolNames: () => [],
			target: (kind) => (kind === "reserved" ? reserved : undefined),
			filesystemPolicy: () => undefined,
		});
		await expect(handler(request({ kind: "completion", args: { prompt: "x" } }))).rejects.toMatchObject({
			code: "host_call_unsupported_kind",
		});
		const signal = new AbortController().signal;
		expect(await handler(request({ kind: "reserved", name: "agent", args: { a: 1 }, signal }))).toEqual({
			served: "agent",
		});
		expect(seen).toEqual([{ name: "agent", args: { a: 1 }, signal }]);
	});
});

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fileHandler(policy?: FilesystemPolicyChecker) {
	return createSessionHostCallHandler({
		cwd: process.cwd(),
		executeNested: () => Promise.reject(new Error("not reached")),
		callableToolNames: () => [],
		target: () => undefined,
		filesystemPolicy: () => policy,
	});
}

/** Whether `promise` has settled once every already-queued task has run. */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise<void>((resolveTick) => setImmediate(resolveTick));
	return settled;
}

describe("session host-call handler: authorize", () => {
	it("answers with the session's policy decision, the same reason text the file tools throw", async () => {
		const asked: unknown[] = [];
		const handler = fileHandler(async (request) => {
			asked.push(request);
			return { allow: false, reason: "blocked by test policy" };
		});
		const args = { operation: "write", path: "/x/y", toolName: "write" };
		const asks = { operation: "write", canonicalPath: "/x/y", toolName: "write" };
		expect(await handler(request({ kind: "authorize", args }))).toEqual({
			allow: false,
			reason: "blocked by test policy",
		});
		expect(await handler(request({ kind: "authorize", args }))).toMatchObject({ allow: false });
		expect(asked).toEqual([asks, asks]);
	});

	it("allows when no policy is registered, and refuses malformed requests typed", async () => {
		const handler = fileHandler();
		expect(
			await handler(request({ kind: "authorize", args: { operation: "read", path: "/a", toolName: "read" } })),
		).toEqual({ allow: true });
		await expect(
			handler(request({ kind: "authorize", args: { operation: "delete", path: "/a", toolName: "x" } })),
		).rejects.toMatchObject({ code: "host_call_bad_args" });
	});
});

describe("session host-call handler: file locks", () => {
	async function file(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "tchc-lock-"));
		dirs.push(dir);
		return join(dir, "f.txt");
	}

	it("holds a second lock on the same file until the first is unlocked; an unknown lock is refused", async () => {
		const handler = fileHandler();
		const path = await file();
		const first = (await handler(request({ kind: "lock_file", args: { path } }))) as { lockId: string };
		const second = handler(request({ kind: "lock_file", args: { path: join(path, "..", "f.txt") } }));
		expect(await settledNow(second)).toBe(false);
		expect(await handler(request({ kind: "unlock_file", args: { lockId: first.lockId } }))).toBeNull();
		const granted = (await second) as { lockId: string };
		await expect(handler(request({ kind: "unlock_file", args: { lockId: first.lockId } }))).rejects.toMatchObject({
			code: "host_call_unknown_lock",
		});
		await handler(request({ kind: "unlock_file", args: { lockId: granted.lockId } }));
	});

	it("never releases on the holder's cancel, only on the child's observed exit", async () => {
		const handler = fileHandler();
		const path = await file();
		let childExited!: () => void;
		const exited = new Promise<void>((resolveExit) => {
			childExited = resolveExit;
		});
		const holderAbort = new AbortController();
		await handler(
			request({
				kind: "lock_file",
				args: { path },
				signal: holderAbort.signal,
				generation: { exited, jobLive: () => true },
			}),
		);
		holderAbort.abort();
		const next = handler(request({ kind: "lock_file", args: { path } }));
		expect(await settledNow(next)).toBe(false);
		childExited();
		const granted = (await next) as { lockId: string };
		await handler(request({ kind: "unlock_file", args: { lockId: granted.lockId } }));
	});

	it("grants only a live job: an ended job is refused, and a waiter whose job ends never holds", async () => {
		const handler = fileHandler();
		const path = await file();
		await expect(
			handler(
				request({
					kind: "lock_file",
					args: { path },
					generation: { exited: new Promise(() => {}), jobLive: () => false },
				}),
			),
		).rejects.toMatchObject({ code: "host_call_job_ended" });
		const held = (await handler(request({ kind: "lock_file", args: { path } }))) as { lockId: string };
		const waiterAbort = new AbortController();
		const waiter = handler(request({ kind: "lock_file", args: { path }, signal: waiterAbort.signal }));
		const after = handler(request({ kind: "lock_file", args: { path } }));
		waiterAbort.abort(new Error("job ended"));
		await expect(waiter).rejects.toThrow("job ended");
		await handler(request({ kind: "unlock_file", args: { lockId: held.lockId } }));
		const granted = (await after) as { lockId: string };
		await handler(request({ kind: "unlock_file", args: { lockId: granted.lockId } }));
	});
});
