// senpi#3622 review: a registered child module gets the SAME host on both runtimes. Its export receives
// `(args, host)` whether the session runs it in-process or on its tool child, and a deadline fails it the same way.
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FilesystemPolicyRequest } from "../src/core/extensions/types.ts";
import { createSessionHostCallHandler } from "../src/core/tool-child-host-calls.ts";
import type { StuckModuleNotice } from "../src/core/tool-dispatch/in-process-module.ts";
import { offload } from "../src/core/tool-dispatch/offload.ts";
import { createToolDispatcher, type ToolChildModuleJob } from "../src/core/tool-dispatch/tool-dispatcher.ts";
import {
	acquireFileMutationLock,
	FileLockedByStuckModuleError,
	withFileMutationQueue,
} from "../src/core/tools/file-mutation-queue.ts";
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

function hostCallsIn(cwd: string, asked: FilesystemPolicyRequest[]) {
	return createSessionHostCallHandler({
		cwd,
		executeNested: () => Promise.reject(new Error("not reached")),
		callableToolNames: () => [],
		target: () => undefined,
		filesystemPolicy: () => async (request) => {
			asked.push(request);
			return request.canonicalPath.includes("secret")
				? { allow: false, reason: "secret paths are off limits (test policy)" }
				: { allow: true };
		},
	});
}

type RunModule = (job: ToolChildModuleJob) => Promise<unknown>;

async function inProcess(cwd: string, asked: FilesystemPolicyRequest[]): Promise<RunModule> {
	const dispatcher = createToolDispatcher({ runtime: "in-process", hostCalls: hostCallsIn(cwd, asked) });
	return async (job) => (await dispatcher.offload(job, undefined)).value;
}

async function onChild(cwd: string, asked: FilesystemPolicyRequest[]): Promise<RunModule> {
	const client = new ToolChildClient({
		dir: cwd,
		cwd,
		command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
		env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify([extensionDir]) },
		onHostCall: hostCallsIn(cwd, asked),
	});
	cleanups.push(() => client.close());
	await client.start();
	return (job) => client.run("module", { modulePath: job.modulePath, export: job.export, args: job.args });
}

describe.skipIf(process.platform === "win32").each([
	["in-process", inProcess],
	["child", onChild],
] as const)("a child module's host (%s runtime)", (_runtime, start) => {
	it("asks the session's filesystem policy and takes the session's file lock", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omh-"));
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		const asked: FilesystemPolicyRequest[] = [];
		const run = await start(cwd, asked);
		expect(await run({ modulePath, export: "writeIfAllowed", args: { path: "notes.txt" } })).toBe("allowed");
		await expect(run({ modulePath, export: "writeIfAllowed", args: { path: "secret.txt" } })).rejects.toThrow(
			"secret paths are off limits (test policy)",
		);
		expect(asked.map((request) => request.toolName)).toEqual(["write", "write"]);
		const file = join(cwd, "log.txt");
		await writeFile(file, "");
		expect(await run({ modulePath, export: "appendLocked", args: { file, line: "one" } })).toBe("one\n");
		expect(await readFile(file, "utf8")).toBe("one\n");
	}, 60_000);
});

describe("ctx.offload deadlines", () => {
	const fakeEntry = {
		registration: { id: "slow", module: modulePath, export: "appendWhenGated" },
		sourceInfo: { path: join(extensionDir, "index.ts") },
	};
	const modules = new Map([["slow", fakeEntry]]) as unknown as Parameters<typeof offload>[1];

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"refuses deadlineMs %s where it enters",
		async (deadlineMs) => {
			const dispatcher = { offload: () => Promise.reject(new Error("not reached")) };
			await expect(offload(dispatcher, modules, "slow", {}, { deadlineMs })).rejects.toMatchObject({
				code: "offload_bad_options",
			});
		},
	);

	it("fails an in-process module past its deadline but keeps its file lock until its write settles", async () => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "omh-")));
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		const dispatcher = createToolDispatcher({ runtime: "in-process", hostCalls: hostCallsIn(cwd, []) });
		const file = join(cwd, "gated.txt");
		const gate = join(cwd, "gate");
		await writeFile(file, "");
		// The module's fs.watch waits for the gate; opening it on every path closes that watcher.
		cleanups.push(() => writeFile(gate, ""));
		const args = { file, line: "late", held: join(cwd, "held"), gate };
		await expect(offload(dispatcher, modules, "slow", args, { deadlineMs: 200 })).rejects.toMatchObject({
			code: "tool_child_deadline",
		});
		let secondWriter = false;
		const second = acquireFileMutationLock(file).then((release) => {
			secondWriter = true;
			return release;
		});
		// Every release the deadline could trigger is promise-driven: two full event-loop turns let it land if it would.
		for (let turn = 0; turn < 2; turn++) await new Promise((resolveTurn) => setImmediate(resolveTurn));
		expect(secondWriter).toBe(false);
		await writeFile(gate, "");
		const release = await second;
		await appendFile(file, "other\n");
		release();
		expect(await readFile(file, "utf8")).toBe("late\nother\n");
	});
	it("reports an in-process module stuck past its grace, fails every waiter on its lock fast, and releases it on dispose", async () => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "omh-")));
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		const file = join(cwd, "stuck.txt");
		const gate = join(cwd, "gate");
		await writeFile(file, "");
		cleanups.push(() => writeFile(gate, ""));
		let reportStuck: (notice: StuckModuleNotice) => void = () => {};
		const reported = new Promise<StuckModuleNotice>((resolveReported) => {
			reportStuck = resolveReported;
		});
		const dispatcher = createToolDispatcher({
			runtime: "in-process",
			hostCalls: hostCallsIn(cwd, []),
			stuckGraceMs: 50,
			onModuleStuck: (notice) => reportStuck(notice),
		});
		const args = { file, line: "late", held: join(cwd, "held"), gate };
		await expect(offload(dispatcher, modules, "slow", args, { deadlineMs: 100 })).rejects.toThrow(
			`still holds the lock on ${file}`,
		);
		const notice = await reported;
		expect(notice).toMatchObject({ export: "appendWhenGated", deadlineMs: 100, files: [file] });
		expect(notice.notice).toContain("--tool-runtime child");
		await expect(acquireFileMutationLock(file)).rejects.toMatchObject({ code: "file_locked_by_stuck_module" });
		await expect(withFileMutationQueue(file, async () => "ran")).rejects.toBeInstanceOf(FileLockedByStuckModuleError);
		await dispatcher.dispose();
		const release = await acquireFileMutationLock(file);
		release();
		expect(await readFile(file, "utf8")).toBe("");
	});
});
