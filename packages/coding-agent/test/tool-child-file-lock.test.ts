// senpi#3566 todo 7: drain-before-release file locks across two sessions' tool children. A lock is the file's slot in
// the session's mutation queue; it passes on only after the holder's write is done (or its child is gone), never on a
// cancel.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

/** One session's tool child, with that session's own host-call handler. */
async function sessionChild(): Promise<{ client: ToolChildClient; pid: () => number }> {
	const dir = await mkdtemp(join(tmpdir(), "tfl-"));
	let pid = -1;
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
			filesystemPolicy: () => undefined,
		}),
		onStatus: (status) => {
			if (status.state === "spawned") pid = status.pid;
		},
	});
	cleanups.push(async () => {
		await client.close();
		await rm(dir, { recursive: true, force: true });
	});
	await client.start();
	return { client, pid: () => pid };
}

/**
 * Resolves once the module writes the FIFO at `path` (bounded). A FIFO, not a watched file: macOS can deliver a
 * directory-watch event seconds late or never on a busy host (#3836).
 */
async function signalled(path: string, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		readFile(path),
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${path} was not signalled within ${timeoutMs} ms`)), timeoutMs);
		}),
	]);
	clearTimeout(timer);
}

/** Whether `promise` settles within `ms` (a bounded negative check: it must NOT settle while the lock is held). */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		new Promise<boolean>((resolveTimer) => {
			timer = setTimeout(() => resolveTimer(false), ms);
		}),
	]);
	clearTimeout(timer);
	return outcome;
}

describe.skipIf(process.platform === "win32")("tool child file locks", () => {
	it("keeps the lock through the holder's cancel until its write is done; the next writer sees that write", async () => {
		const [a, b] = [await sessionChild(), await sessionChild()];
		const work = await mkdtemp(join(tmpdir(), "tfl-work-"));
		cleanups.push(() => rm(work, { recursive: true, force: true }));
		const file = join(work, "shared.txt");
		await writeFile(file, "");
		const held = join(work, "a-held");
		execFileSync("mkfifo", [held]);
		// A FIFO, not a watched file: macOS can deliver a directory-watch event after the cancel grace, or never (#3836).
		const gate = join(work, "a-gate");
		execFileSync("mkfifo", [gate]);
		const cancelA = new AbortController();
		const runA = a.client.run(
			"module",
			{ modulePath, export: "appendWhenFifoOpens", args: { file, line: "A", held, gate } },
			cancelA.signal,
		);
		void runA.catch(() => undefined);
		await signalled(held, 15_000);
		cancelA.abort();
		const runB = b.client.run("module", { modulePath, export: "appendLocked", args: { file, line: "B" } });
		expect(await settlesWithin(runB, 500)).toBe(false);
		await writeFile(gate, "go");
		expect(await runB).toBe("A\nB\n");
	}, 60_000);

	it("releases a dead child's lock once its exit is observed: the next writer proceeds within 1 s", async () => {
		const [a, b] = [await sessionChild(), await sessionChild()];
		const work = await mkdtemp(join(tmpdir(), "tfl-work-"));
		cleanups.push(() => rm(work, { recursive: true, force: true }));
		const file = join(work, "shared.txt");
		await writeFile(file, "");
		const held = join(work, "a-held");
		execFileSync("mkfifo", [held]);
		void a.client
			.run("module", {
				modulePath,
				export: "appendWhenGated",
				args: { file, line: "A", held, gate: join(work, "never") },
			})
			.catch(() => undefined);
		await signalled(held, 15_000);
		const runB = b.client.run("module", { modulePath, export: "appendLocked", args: { file, line: "B" } });
		expect(await settlesWithin(runB, 500)).toBe(false);
		const killedAt = Date.now();
		process.kill(a.pid(), "SIGKILL");
		expect(await runB).toBe("B\n");
		expect(Date.now() - killedAt).toBeLessThanOrEqual(1_000);
	}, 60_000);
});
