import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostToKernelMessage } from "../src/bridge/protocol.ts";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import { FakeChild } from "./py-kernel/fixtures.ts";

// senpi#3612: a notice must name the globals a lost kernel took with it, whether it died in this
// session manager or an earlier generation of the same session (reload, host restart, resume) ended it.

type SpawnedSlot = { queue: unknown[]; all: unknown[] };
const spawned: SpawnedSlot = vi.hoisted((): SpawnedSlot => ({ queue: [], all: [] }));

vi.mock("../src/kernels/py/process.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/kernels/py/process.ts")>();
	return {
		...actual,
		defaultSpawn: () => {
			const next = spawned.queue.shift();
			if (!(next instanceof FakeChild)) throw new Error("unexpected Python spawn");
			spawned.all.push(next);
			return next;
		},
	};
});

vi.mock("../src/kernels/shared/host-memory-state.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/kernels/shared/host-memory-state.ts")>();
	return { ...actual, readHostMemoryState: async () => "system memory pressure critical, swap used 68.4 GB" };
});

const availability: InterpreterAvailability = {
	js: { enabled: false, detected: { ok: false } },
	py: { enabled: true, detected: { ok: true, path: "python3", version: "3" } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

/** Answers every cell with the globals its code names as `define a b c`, after a 14 MB reading. */
function definingChild(options: { readonly outlivesHostKill?: boolean } = {}): FakeChild {
	const defined = new Set<string>();
	const child: FakeChild = new FakeChild({
		autoRun: false,
		remainAliveOnSigkill: options.outlivesHostKill === true,
		onRun: (message: Extract<HostToKernelMessage, { type: "run" }>) => {
			const [verb, ...names] = message.code.split(" ");
			if (verb === "define") for (const name of names) defined.add(name);
			child.emitMessage({
				type: "result",
				cellId: message.cellId,
				ok: true,
				durationMs: 1,
				memory: { liveBytes: 14 * 1024 * 1024, measure: "footprint" },
				globalCount: defined.size,
				globalNames: [...defined].sort(),
			});
		},
	});
	return child;
}

const managers: CodemodeSessionManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	spawned.queue.length = 0;
	spawned.all.length = 0;
});

function sessionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemode-py-lost-globals-"));
	dirs.push(dir);
	return dir;
}

async function pythonSession(artifactsDir: string): Promise<CodemodeSessionManager> {
	const manager = await createCodemodeSessionManager({
		sessionId: "py-lost-globals",
		cwd: artifactsDir,
		artifactsDir,
		settings: defaultCodemodeSettings,
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => {
			throw new Error("completion is not exercised here");
		},
	});
	managers.push(manager);
	return manager;
}

describe("restart notices name the globals a lost Python kernel held", () => {
	it("a SIGKILL from outside names the lost globals, the last reading, and the host's memory state", async () => {
		const killed = definingChild({ outlivesHostKill: true });
		spawned.queue.push(killed, definingChild());
		const kernel = await (await pythonSession(sessionDir())).getKernel("py", () => undefined);
		await kernel.run({ cellId: "define", code: "define helper load_rows" });

		killed.finish(null, "SIGKILL");
		const next = await kernel.run({ cellId: "after", code: "use" });

		expect(next).toMatchObject({ ok: true, kernelState: "restarted" });
		expect(next.notice).toBe(
			"[py kernel was restarted after signal 9 (its last reading was 14 MB in its process footprint), probably killed by the system, most often under memory pressure (system memory pressure critical, swap used 68.4 GB); every global is lost. Lost: helper, load_rows]",
		);
	}, 30_000);

	it("a later generation of the same session names what the previous kernel held, once", async () => {
		const artifactsDir = sessionDir();
		spawned.queue.push(definingChild(), definingChild());
		const first = await pythonSession(artifactsDir);
		await (await first.getKernel("py", () => undefined)).run({ cellId: "define", code: "define helper" });
		await first.dispose();

		const kernel = await (await pythonSession(artifactsDir)).getKernel("py", () => undefined);
		const fresh = await kernel.run({ cellId: "fresh", code: "use" });
		const later = await kernel.run({ cellId: "later", code: "use" });

		expect(fresh).toMatchObject({ ok: true, kernelState: "restarted" });
		expect(fresh.notice).toBe(
			"[py kernel is new: this session's previous py kernel ended (session reload, host restart, or resume), so every global it held is gone. Lost: helper]",
		);
		expect(later.notice).toBeUndefined();
	}, 30_000);

	it("a reset leaves nothing for a later generation to announce", async () => {
		const artifactsDir = sessionDir();
		spawned.queue.push(definingChild(), definingChild(), definingChild());
		const first = await pythonSession(artifactsDir);
		const kernel = await first.getKernel("py", () => undefined);
		await kernel.run({ cellId: "define", code: "define helper" });
		await kernel.reset();
		await first.dispose();

		const next = await (await pythonSession(artifactsDir)).getKernel("py", () => undefined);
		expect((await next.run({ cellId: "fresh", code: "use" })).notice).toBeUndefined();
	}, 30_000);
});
