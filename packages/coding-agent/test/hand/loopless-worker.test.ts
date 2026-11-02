// senpi#5413 (RT10, brain/hand split): a session worker's runtime with only the agent loop removed. It is
// built from the same launch configuration as the CLI runtime, serves the built-in and extension tools,
// and binds no loop, so an extension that tries to start a turn is refused. Guards the F41 loopless-worker
// surface.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { grantLooplessExecuteToTestHarness } from "../../src/modes/rpc/loopless-execute-grant.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { LooplessWorker } from "../../src/modes/rpc/loopless-worker-client.ts";
import { LooplessWorkerPool } from "../../src/modes/rpc/loopless-worker-pool.ts";
import {
	createLooplessRuntimeFactory,
	type LooplessRuntime,
	LooplessToolNotFoundError,
} from "../../src/modes/rpc/runtime-factory-loopless.ts";
import type { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import { SESSION_WORKER_LIMITS, type WorkerSnapshot } from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerCapacity } from "../../src/modes/rpc/worker-capacity.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function handExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echoes its value.",
		parameters: Type.Object({ value: Type.Number() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: JSON.stringify({ value: params.value }) }], details: {} };
		},
	});
	pi.registerTool({
		name: "start_turn",
		label: "Start turn",
		description: "Tries to start an agent turn from inside a tool call.",
		parameters: Type.Object({}),
		async execute() {
			try {
				pi.sendUserMessage("continue");
				return { content: [{ type: "text", text: "turn started" }], details: {} };
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				return { content: [{ type: "text", text: `refused: ${message}` }], details: {} };
			}
		},
	});
}

async function looplessRuntime(): Promise<LooplessRuntime> {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-loopless-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "note.txt"), "written before the call\n");
	const factory = createLooplessRuntimeFactory(
		{
			parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
			cwd,
			agentDir,
			appMode: "rpc",
		},
		{ extensionFactories: [handExtension], executeGrant: grantLooplessExecuteToTestHarness() },
	);
	const runtime = await factory({ cwd });
	cleanups.push(async () => {
		await runtime.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	return runtime;
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("loopless worker runtime (senpi#5413)", () => {
	it("serves the built-in tools and the configured extension's tools", async () => {
		const runtime = await looplessRuntime();

		const names = [...runtime.definitions.keys()];

		expect(names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "echo", "start_turn"]));
		expect(runtime.definitions.get("read")?.sourceInfo.source).toBe("builtin");
		expect(runtime.definitions.get("echo")?.sourceInfo.source).not.toBe("builtin");
	});

	it("runs a built-in tool call in the runtime's cwd", async () => {
		const runtime = await looplessRuntime();

		const result = await runtime.execute("read", "call-read", { path: "note.txt" });

		expect(text(result)).toContain("written before the call");
	});

	it("runs echo({value:42}) through the extension's tool", async () => {
		const runtime = await looplessRuntime();

		const result = await runtime.execute("echo", "call-echo", { value: 42 });

		expect(text(result)).toBe('{"value":42}');
	});

	it("binds no agent loop: an extension that tries to start a turn is refused", async () => {
		const runtime = await looplessRuntime();

		const result = await runtime.execute("start_turn", "call-turn", {});

		expect(text(result)).toMatch(/^refused: Extension runtime not initialized/);
	});

	it("refuses an unknown tool before anything runs", async () => {
		const runtime = await looplessRuntime();

		await expect(runtime.execute("missing", "call-missing", {})).rejects.toBeInstanceOf(LooplessToolNotFoundError);
	});
});

// The admission path under test is production code; the workers are in-memory stand-ins, so counts are exact and
// nothing depends on machine load (as in X4, test/characterization/worker-cap.test.ts).
function looplessStandIns(options: { holdStart?: Promise<void>; failStart?: boolean } = {}) {
	const started: LooplessWorker[] = [];
	const closed: LooplessWorker[] = [];
	const createWorker = (): LooplessWorker => {
		let exit: () => void = () => {};
		const exited = new Promise<void>((resolve) => {
			exit = resolve;
		});
		const worker: LooplessWorker = {
			exited,
			start: async () => {
				await options.holdStart;
				if (options.failStart) throw new Error("runtime failed to build");
				return ["read"];
			},
			close: async () => {
				closed.push(worker);
				exit();
			},
		};
		started.push(worker);
		return worker;
	};
	return { started, closed, createWorker };
}

function sessionRegistry(capacity: WorkerCapacity, cwd: string): WorkerSessionRegistry {
	let serial = 0;
	return new WorkerSessionRegistry({
		configuration: { parsed: parseArgs(["--mode", "rpc"]), cwd, agentDir: join(cwd, "agent"), appMode: "rpc" },
		closeGraceMs: 10_000,
		now: Date.now,
		capacity,
		createWorker: () => {
			const id = ++serial;
			const path = join(cwd, `session-${id}.jsonl`);
			const snapshot = {
				state: { sessionId: `durable-${id}`, sessionFile: path, cwd },
				sessionPath: path,
				liveSessionPaths: [path],
				busy: false,
				streaming: false,
			} as unknown as WorkerSnapshot;
			return {
				snapshot,
				bindingReady: true,
				busy: false,
				exited: Promise.resolve(),
				prepare: async () => path,
				commit: async () => snapshot,
				close: async () => {},
				quarantine: () => {},
			} as unknown as SessionWorkerClient;
		},
	});
}

function looplessPool(capacity: WorkerCapacity, createWorker: () => LooplessWorker): LooplessWorkerPool {
	return new LooplessWorkerPool({
		configuration: { parsed: parseArgs(["--mode", "rpc"]), cwd: tmpdir(), agentDir: tmpdir(), appMode: "rpc" },
		capacity,
		closeGraceMs: 10_000,
		createWorker,
	});
}

async function refusal(open: Promise<unknown>): Promise<string | undefined> {
	return open.then(
		() => undefined,
		(cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
	);
}

describe("MULTI cap: the per-hand worker cap holds across sessions (Z2, senpi#5413)", () => {
	it("admits the cap's loopless workers across sessions and refuses the next one, starting no worker", async () => {
		const standIns = looplessStandIns();
		const pool = looplessPool(new WorkerCapacity(), standIns.createWorker);
		for (let i = 0; i < SESSION_WORKER_LIMITS.workers; i++) await pool.open(tmpdir());

		const refused = await refusal(pool.open(tmpdir()));

		expect(refused).toBe("too_many_sessions");
		expect(standIns.started).toHaveLength(SESSION_WORKER_LIMITS.workers);
		expect(pool.size).toBe(SESSION_WORKER_LIMITS.workers);
	});

	it("counts loopless workers still starting against the cap", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const standIns = looplessStandIns({ holdStart: held });
		const pool = looplessPool(new WorkerCapacity(), standIns.createWorker);
		const pending = Array.from({ length: SESSION_WORKER_LIMITS.workers }, () => pool.open(tmpdir()));

		const refused = await refusal(pool.open(tmpdir()));

		expect(refused).toBe("too_many_sessions");
		release();
		await expect(Promise.all(pending)).resolves.toHaveLength(SESSION_WORKER_LIMITS.workers);
	});

	it("shares one cap with the session workers of the same process", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-cap-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const capacity = new WorkerCapacity();
		const registry = sessionRegistry(capacity, scratch);
		const pool = looplessPool(capacity, looplessStandIns().createWorker);
		const half = SESSION_WORKER_LIMITS.workers / 2;
		for (let i = 0; i < half; i++) await registry.openSession({ cwd: scratch });
		for (let i = 0; i < half; i++) await pool.open(scratch);

		const looplessRefused = await refusal(pool.open(scratch));
		const sessionRefused = await refusal(registry.openSession({ cwd: scratch }));

		expect([looplessRefused, sessionRefused]).toEqual(["too_many_sessions", "too_many_sessions"]);
	});

	it("frees exactly one slot when one loopless worker closes", async () => {
		const pool = looplessPool(new WorkerCapacity(), looplessStandIns().createWorker);
		const opened = [];
		for (let i = 0; i < SESSION_WORKER_LIMITS.workers; i++) opened.push(await pool.open(tmpdir()));

		await pool.close(opened[0]?.id ?? "");

		await pool.open(tmpdir());
		expect(await refusal(pool.open(tmpdir()))).toBe("too_many_sessions");
	});

	it("a worker whose runtime fails to start is closed and frees its slot", async () => {
		const failing = looplessStandIns({ failStart: true });
		const capacity = new WorkerCapacity();
		const pool = looplessPool(capacity, failing.createWorker);

		const refused = await refusal(pool.open(tmpdir()));

		expect([refused, failing.closed.length, pool.size, capacity.inUse()]).toEqual([
			"runtime failed to build",
			1,
			0,
			0,
		]);
	});
});
