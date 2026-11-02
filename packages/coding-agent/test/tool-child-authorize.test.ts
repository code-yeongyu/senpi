// senpi#3566 todo 7: a child-run body asks the session's filesystem policy over the reverse bridge; a denial reaches it
// with the policy's own reason text (the same text the in-process file tools throw), and nothing is cached.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FilesystemPolicyRequest } from "../src/core/extensions/types.ts";
import { createSessionHostCallHandler } from "../src/core/tool-child-host-calls.ts";
import { ToolChildClient } from "../src/modes/rpc/tool-child/client.ts";
import { TOOL_CHILD_MODULE_ROOTS_ENV } from "../src/modes/rpc/tool-child/module-job.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../src/experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../src/tool-child-main.ts");
const extensionDir = resolve(import.meta.dirname, "fixtures/module-job-ext");
const modulePath = join(extensionDir, "offload.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(process.platform === "win32")("tool child authorization", () => {
	it("answers each request from the session's policy; a denial fails the body with the policy's reason", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tca-"));
		const asked: FilesystemPolicyRequest[] = [];
		const client = new ToolChildClient({
			dir,
			cwd: dir,
			command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
			env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify([extensionDir]) },
			onHostCall: createSessionHostCallHandler({
				cwd: process.cwd(),
				executeNested: () => Promise.reject(new Error("not reached")),
				callableToolNames: () => [],
				target: () => undefined,
				filesystemPolicy: () => async (request) => {
					asked.push(request);
					return request.canonicalPath.includes("secret")
						? { allow: false, reason: "secret paths are off limits (test policy)" }
						: { allow: true };
				},
			}),
		});
		cleanups.push(async () => {
			await client.close();
			await rm(dir, { recursive: true, force: true });
		});
		await client.start();
		const run = (path: string) => client.run("module", { modulePath, export: "writeIfAllowed", args: { path } });
		expect(await run("/work/notes.txt")).toBe("allowed");
		await expect(run("/work/secret.txt")).rejects.toThrow("secret paths are off limits (test policy)");
		expect(await run("/work/notes.txt")).toBe("allowed");
		expect(asked.map((request) => [request.operation, request.canonicalPath, request.toolName])).toEqual([
			["write", "/work/notes.txt", "write"],
			["write", "/work/secret.txt", "write"],
			["write", "/work/notes.txt", "write"],
		]);
	}, 60_000);
});
