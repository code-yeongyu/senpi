import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { KernelMemoryThresholds } from "../../../src/bridge/memory-protocol.ts";
import { decodeBridgeFrame, encodeBridgeFrame, type KernelToHostMessage } from "../../../src/bridge/protocol.ts";
import { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";

const MIB = 1024 * 1024;
const lowered: KernelMemoryThresholds = {
	gcWatermarkBytes: 32 * MIB,
	noticeBytes: 64 * MIB,
	ceilingBytes: 128 * MIB,
};
// Above every platform's pid_max: signalling this "process group" finds nothing and falls back to child.kill.
const FAKE_PID_BASE = 2 ** 30;

class FakeInterpreter extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly ranCellIds: string[] = [];
	readonly stdin = {
		write: (chunk: string): boolean => {
			const decoded = decodeBridgeFrame(chunk);
			if (!decoded.ok) return true;
			const message = decoded.message;
			if (message.type === "init") this.#emit({ type: "ready" });
			if (message.type === "run") {
				this.ranCellIds.push(message.cellId);
				this.#emit({ type: "result", cellId: message.cellId, ok: true, valueRepr: "nil", durationMs: 1 });
			}
			return true;
		},
	};

	readonly pid: number;

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}

	#emit(message: KernelToHostMessage): void {
		setImmediate(() => this.stdout.write(encodeBridgeFrame(message)));
	}
}

describe.each(["rb", "jl"] as const)("SubprocessKernel (%s) memory ceiling", (language) => {
	it("Given an interpreter footprint over the ceiling with a cell queued behind it when both settle then the queued cell runs on the same interpreter and the next cell on a fresh one", async () => {
		const spawned: FakeInterpreter[] = [];
		const footprints = new Map<number, number>();
		const kernel = new SubprocessKernel({
			command: language === "rb" ? "ruby" : "julia",
			args: [],
			sessionId: `${language}-memory`,
			connection: { port: 1, token: "t" },
			spawn: () => {
				const interpreter = new FakeInterpreter(FAKE_PID_BASE + spawned.length);
				footprints.set(interpreter.pid, spawned.length === 0 ? 200 * MIB : 10 * MIB);
				spawned.push(interpreter);
				return interpreter;
			},
			memory: {
				language,
				thresholds: lowered,
				readFootprint: (pid) => {
					const bytes = footprints.get(pid);
					return bytes === undefined ? undefined : { bytes };
				},
			},
		});
		try {
			const offending = kernel.run({ cellId: "offending", code: "big" });
			const queued = kernel.run({ cellId: "queued", code: "big" });
			const offendingResult = await offending;
			const queuedResult = await queued;
			const next = await kernel.run({ cellId: "next", code: "fresh" });

			expect(offendingResult.memory).toMatchObject({
				liveBytes: 200 * MIB,
				measure: "footprint",
				overCeiling: true,
			});
			expect(offendingResult.memory?.notice).toBeDefined();
			expect(offendingResult.memory?.gcRan).toBeUndefined();
			expect(offendingResult.memory?.globals).toBeUndefined();
			expect(queuedResult).toMatchObject({ ok: true, memory: { overCeiling: true } });
			expect(queuedResult.memory?.notice).toBeUndefined();
			expect(next).toMatchObject({ ok: true, memory: { liveBytes: 10 * MIB, recycled: true } });
			expect(next.memory?.notice).toBeDefined();
			expect(spawned.map((interpreter) => interpreter.ranCellIds)).toEqual([["offending", "queued"], ["next"]]);
		} finally {
			await kernel.close();
		}
	});

	it("Given an interpreter footprint over the notice threshold but under the ceiling when a cell settles then the result carries the large-memory notice without a restart", async () => {
		const kernel = new SubprocessKernel({
			command: language === "rb" ? "ruby" : "julia",
			args: [],
			sessionId: `${language}-memory-notice`,
			connection: { port: 1, token: "t" },
			spawn: () => new FakeInterpreter(FAKE_PID_BASE),
			memory: { language, thresholds: lowered, readFootprint: () => ({ bytes: 100 * MIB }) },
		});
		try {
			const result = await kernel.run({ cellId: "under-ceiling", code: "big" });

			expect(result.memory).toMatchObject({ liveBytes: 100 * MIB, measure: "footprint" });
			expect(result.memory?.notice).toBeDefined();
			expect(result.memory?.overCeiling).toBeUndefined();
			expect(result.memory?.recycled).toBeUndefined();
		} finally {
			await kernel.close();
		}
	});
});
