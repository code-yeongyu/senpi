import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { EventLoopSlicer } from "../../../src/core/event-loop-slicer.ts";
import { loadEntriesFromFile, SessionManager } from "../../../src/core/session-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { fakeSessionBase } from "../../helpers/fake-session-base.ts";

/**
 * senpi#3518: a multi-session host runs every session on one event loop, so opening a large
 * transcript must hand the loop back while it parses. Slicing is made deterministic with a
 * clock that advances one millisecond per read: the assertions count loop turns, never time.
 */

const ENTRY_COUNT = 2_000;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-3518-"));
	dirs.push(dir);
	return dir;
}

function steppingSlicer(): EventLoopSlicer {
	let now = 0;
	return new EventLoopSlicer({ clock: () => now++ });
}

/** Runs `onYield` at the first slice boundary, then yields like any slicer. */
class HookedSlicer extends EventLoopSlicer {
	private fired = false;
	private readonly onYield: () => void;
	constructor(onYield: () => void) {
		let now = 0;
		super({ clock: () => now++ });
		this.onYield = onYield;
	}
	override async yield(): Promise<void> {
		if (!this.fired) {
			this.fired = true;
			this.onYield();
		}
		await super.yield();
	}
}

function writeTranscript(path: string, cwd: string): void {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "issue-3518", timestamp: "2026-10-17T00:00:00.000Z", cwd }),
	];
	let parentId: string | null = null;
	for (let index = 0; index < ENTRY_COUNT; index++) {
		const id = `entry-${index}`;
		const text = index === 7 ? "x".repeat(40 * 1024) : `message ${index}`;
		const role = index % 2 === 0 ? "user" : "assistant";
		const message =
			role === "user"
				? { role, content: [{ type: "text", text }], timestamp: index }
				: {
						role,
						content: [{ type: "text", text }],
						api: "faux",
						provider: "faux",
						model: "faux-1",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: index,
					};
		lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-17T00:00:00.000Z", message }));
		parentId = id;
		if (index === 100) lines.push("", "{not json");
	}
	// No trailing newline: the open must terminate the final entry before appending.
	writeFileSync(path, lines.join("\n"));
}

async function countLoopTurnsDuring<T>(work: () => Promise<T>): Promise<{ value: T; turns: number }> {
	let turns = 0;
	let running = true;
	const tick = (): void => {
		if (!running) return;
		turns++;
		setImmediate(tick);
	};
	setImmediate(tick);
	try {
		return { value: await work(), turns };
	} finally {
		running = false;
	}
}

function snapshot(manager: SessionManager) {
	return {
		sessionId: manager.getSessionId(),
		cwd: manager.getCwd(),
		leafId: manager.getLeafId(),
		entries: manager.getEntries(),
		context: manager.buildSessionContext(),
	};
}

describe("issue #3518: opening a large session yields to the event loop", () => {
	test("openAsync loads exactly what open loads, and hands the loop back while it parses", async () => {
		const dir = tempDir();
		const syncPath = join(dir, "sync.jsonl");
		const asyncPath = join(dir, "async.jsonl");
		writeTranscript(syncPath, dir);
		writeTranscript(asyncPath, dir);
		const expected = snapshot(SessionManager.open(syncPath));

		const { value: manager, turns } = await countLoopTurnsDuring(() =>
			SessionManager.openAsync(asyncPath, undefined, undefined, undefined, steppingSlicer()),
		);

		expect(turns).toBeGreaterThanOrEqual(ENTRY_COUNT / 10);
		const actual = snapshot(manager);
		expect(actual).toEqual(expected);
		expect(actual.entries).toHaveLength(ENTRY_COUNT);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "after reopen" }], timestamp: 1 });
		expect(SessionManager.open(asyncPath).getEntries()).toHaveLength(ENTRY_COUNT + 1);
	});

	test("openAsync matches open for a missing, an empty and a non-session file", async () => {
		const dir = tempDir();
		const missing = await SessionManager.openAsync(join(dir, "missing.jsonl"), undefined, dir, { id: "caller-id" });
		expect(missing.getSessionId()).toBe("caller-id");
		expect(missing.getEntries()).toEqual([]);

		writeFileSync(join(dir, "empty.jsonl"), "");
		const empty = await SessionManager.openAsync(join(dir, "empty.jsonl"), undefined, dir, { id: "empty-id" });
		expect(empty.getSessionId()).toBe("empty-id");

		writeFileSync(join(dir, "other.jsonl"), '{"type":"message","id":"a"}\n');
		await expect(SessionManager.openAsync(join(dir, "other.jsonl"))).rejects.toThrow(/not a valid .* session/);
		expect(() => SessionManager.open(join(dir, "other.jsonl"))).toThrow(/not a valid .* session/);
	});

	test("openAsync matches open when the file ends in a truncated half line", async () => {
		const dir = tempDir();
		const syncPath = join(dir, "sync.jsonl");
		const asyncPath = join(dir, "async.jsonl");
		for (const path of [syncPath, asyncPath]) {
			writeTranscript(path, dir);
			appendFileSync(path, '\n{"type":"message","id":"torn","parentId":"entry-1999","mess');
		}
		const expected = snapshot(SessionManager.open(syncPath));
		const actual = snapshot(
			await SessionManager.openAsync(asyncPath, undefined, undefined, undefined, steppingSlicer()),
		);

		expect(actual).toEqual(expected);
		expect(actual.entries).toHaveLength(ENTRY_COUNT);
		expect(actual.entries.some((entry) => entry.id === "torn")).toBe(false);
		expect(readFileSync(asyncPath, "utf8").endsWith("\n")).toBe(true);
		expect(readFileSync(asyncPath, "utf8")).toBe(readFileSync(syncPath, "utf8"));
	});

	test("a line appended while the load is slicing is either fully loaded or not at all", async () => {
		const dir = tempDir();
		const path = join(dir, "appending.jsonl");
		writeTranscript(path, dir);
		appendFileSync(path, "\n");
		const appended = {
			type: "message",
			id: "late",
			parentId: "entry-1999",
			timestamp: "2026-10-17T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "late" }], timestamp: 1 },
		};
		const slicer = new HookedSlicer(() => appendFileSync(path, `${JSON.stringify(appended)}\n`));

		const manager = await SessionManager.openAsync(path, undefined, undefined, undefined, slicer);

		const ids = manager.getEntries().map((entry) => entry.id);
		expect(ids.slice(0, ENTRY_COUNT)).toEqual(Array.from({ length: ENTRY_COUNT }, (_, index) => `entry-${index}`));
		expect(ids).toHaveLength(ENTRY_COUNT + 1);
		expect(ids.at(-1)).toBe("late");
		expect(loadEntriesFromFile(path)).toHaveLength(ENTRY_COUNT + 2);
	});

	test("a failure in the middle of the load rejects the open and leaves the session openable", async () => {
		const dir = tempDir();
		const path = join(dir, "failing.jsonl");
		writeTranscript(path, dir);
		const failing = new HookedSlicer(() => {
			throw new Error("load interrupted");
		});

		await expect(SessionManager.openAsync(path, undefined, undefined, undefined, failing)).rejects.toThrow(
			"load interrupted",
		);

		const reopened = await SessionManager.openAsync(path, undefined, undefined, undefined, steppingSlicer());
		expect(reopened.getEntries()).toHaveLength(ENTRY_COUNT);
	});

	test("a session worker isolate loads its session file in one blocking pass", async () => {
		const dir = tempDir();
		const sessionPath = join(dir, "worker.jsonl");
		writeTranscript(sessionPath, dir);
		const worker = new Worker(new URL("./issue-3518-worker-load-fixture.ts", import.meta.url), {
			workerData: { agentDir: dir, cwd: dir, sessionPath },
		});
		try {
			const result = await new Promise<{ loads: string[]; durableSessionId: string }>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
				worker.once("exit", (code) => reject(new Error(`worker exited with ${code} before reporting`)));
			});

			expect(result).toEqual({ loads: ["blocking"], durableSessionId: "issue-3518" });
		} finally {
			await worker.terminate();
		}
	});

	test("the RPC host's open_session loads a transcript in slices instead of holding the loop", async () => {
		const dir = tempDir();
		const sessionPath = join(dir, "host.jsonl");
		writeTranscript(sessionPath, dir);
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			return {
				session: {
					...fakeSessionBase(options),
					extensionRunner: { hasHandlers: () => false, emit: async () => {} },
					abort: async () => {},
					abortBash: () => {},
					waitForIdle: async () => {},
					dispose: () => {},
				},
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		};
		const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime, createSlicer: steppingSlicer });

		const { value: opened, turns } = await countLoopTurnsDuring(() =>
			registry.openSession({ cwd: dir, sessionPath, permissionPreset: "default" }),
		);

		expect(opened.durableSessionId).toBe("issue-3518");
		expect(turns).toBeGreaterThanOrEqual(ENTRY_COUNT / 10);
		await registry.close(opened.sessionId);
	});
});
