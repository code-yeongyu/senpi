// senpi#3603 review: the server, not the child, decides which file a reverse call names. `authorize` and `lock_file`
// resolve the child's path against the SESSION cwd and canonicalize it exactly like the built-in file tools, so a
// relative path, a `..` escape or a symlink alias reaches the policy and the mutation queue as the real file.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FilesystemPolicyRequest } from "../src/core/extensions/types.ts";
import { createSessionHostCallHandler } from "../src/core/tool-child-host-calls.ts";
import { acquireFileMutationLock } from "../src/core/tools/file-mutation-queue.ts";
import type { HostCallRequest } from "../src/modes/rpc/tool-child/host-calls-server.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "tchp-")));
	roots.push(root);
	return root;
}

function request(overrides: Partial<HostCallRequest>): HostCallRequest {
	return {
		callId: "c1",
		jobId: "j1",
		kind: "authorize",
		name: undefined,
		args: null,
		signal: new AbortController().signal,
		context: undefined,
		generation: { exited: new Promise(() => {}), jobLive: () => true },
		...overrides,
	};
}

function handlerIn(cwd: string, asked: FilesystemPolicyRequest[] = []) {
	return createSessionHostCallHandler({
		cwd,
		executeNested: () => Promise.reject(new Error("not reached")),
		callableToolNames: () => [],
		target: () => undefined,
		filesystemPolicy: () => async (policyRequest) => {
			asked.push(policyRequest);
			return policyRequest.canonicalPath.startsWith(cwd + sep)
				? { allow: true }
				: { allow: false, reason: "outside the workspace (test policy)" };
		},
	});
}

describe("reverse-call paths are the server's own canonical paths", () => {
	it("resolves a relative path against the session cwd, never the server process cwd", async () => {
		const cwd = await tempRoot();
		const asked: FilesystemPolicyRequest[] = [];
		const decision = await handlerIn(
			cwd,
			asked,
		)(request({ args: { operation: "write", path: "notes.txt", toolName: "write" } }));
		expect(decision).toEqual({ allow: true });
		expect(asked.map((r) => r.canonicalPath)).toEqual([join(cwd, "notes.txt")]);
	});

	it("canonicalizes a .. escape before the policy sees it", async () => {
		const cwd = join(await tempRoot(), "work");
		await mkdir(cwd);
		const asked: FilesystemPolicyRequest[] = [];
		const decision = await handlerIn(
			cwd,
			asked,
		)(request({ args: { operation: "write", path: "sub/../../outside.txt", toolName: "write" } }));
		expect(decision).toEqual({ allow: false, reason: "outside the workspace (test policy)" });
		expect(asked.map((r) => r.canonicalPath)).toEqual([join(cwd, "..", "outside.txt")]);
	});

	it("follows a symlink alias to the real file", async () => {
		const cwd = await tempRoot();
		const elsewhere = await tempRoot();
		await symlink(elsewhere, join(cwd, "link"));
		const asked: FilesystemPolicyRequest[] = [];
		const decision = await handlerIn(
			cwd,
			asked,
		)(request({ args: { operation: "read", path: "link/secret.txt", toolName: "read" } }));
		expect(decision).toEqual({ allow: false, reason: "outside the workspace (test policy)" });
		expect(asked.map((r) => r.canonicalPath)).toEqual([join(elsewhere, "secret.txt")]);
	});

	it("ignores a canonical path the child claims", async () => {
		const cwd = await tempRoot();
		const asked: FilesystemPolicyRequest[] = [];
		await handlerIn(
			cwd,
			asked,
		)(
			request({
				args: { operation: "write", path: "/etc/hosts", canonicalPath: join(cwd, "fine.txt"), toolName: "write" },
			}),
		);
		expect(asked.map((r) => r.canonicalPath)).toEqual([await realpath("/etc/hosts")]);
	});

	it("takes the same mutation slot as the built-in tools for a session-relative path", async () => {
		const cwd = await tempRoot();
		const handler = handlerIn(cwd);
		const held = await handler(request({ kind: "lock_file", args: { path: "shared.txt" } }));
		const order: string[] = [];
		const builtIn = acquireFileMutationLock(join(cwd, "shared.txt")).then((release) => {
			order.push("built-in acquired");
			return release;
		});
		const unrelated = await acquireFileMutationLock(join(cwd, "unrelated.txt"));
		unrelated();
		expect(order).toEqual([]);
		order.push("child unlocked");
		await handler(request({ kind: "unlock_file", args: { lockId: Reflect.get(Object(held), "lockId") } }));
		(await builtIn)();
		expect(order).toEqual(["child unlocked", "built-in acquired"]);
	});

	it("refuses every call of a job that has already ended", async () => {
		const cwd = await tempRoot();
		const ended = { exited: new Promise<void>(() => {}), jobLive: () => false };
		const handler = handlerIn(cwd);
		await expect(
			handler(request({ generation: ended, args: { operation: "read", path: "notes.txt", toolName: "read" } })),
		).rejects.toMatchObject({ code: "host_call_job_ended" });
		await expect(handler(request({ generation: ended, kind: "completion", args: {} }))).rejects.toMatchObject({
			code: "host_call_job_ended",
		});
	});
});
