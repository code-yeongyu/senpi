import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import { startBridgeServer } from "../../src/bridge/http-server.ts";
import { decodeBridgeFrame, encodeBridgeFrame, type KernelToHostMessage } from "../../src/bridge/protocol.ts";
import { createInterpreterDetector } from "../../src/interpreters/detect.ts";
import { JuliaKernel } from "../../src/kernels/jl/kernel.ts";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import { PythonKernel } from "../../src/kernels/py/kernel.ts";
import { RubyKernel } from "../../src/kernels/rb/kernel.ts";
import type { SubprocessLike } from "../../src/kernels/shared/subprocess-process.ts";
import type { EvalKernel, EvalLanguage } from "../../src/tool/types.ts";

export function textOf(messages: readonly KernelToHostMessage[]): string {
	return messages.flatMap((message) => (message.type === "text" ? [message.data] : [])).join("");
}

/** Stand-in ruby/julia interpreter: records the run frames it was handed and the signals it received. */
export class QueueSubprocess extends EventEmitter implements SubprocessLike {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly runCellIds: string[] = [];
	readonly killSignals: NodeJS.Signals[] = [];
	exited = false;
	readonly stdin = {
		write: (chunk: string): boolean => {
			this.#consume(chunk);
			return true;
		},
	};
	readonly #onRun: (cellId: string) => void;

	constructor(onRun: (cellId: string) => void) {
		super();
		this.#onRun = onRun;
	}

	emitMessage(message: KernelToHostMessage): void {
		this.stdout.write(encodeBridgeFrame(message));
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killSignals.push(signal);
		queueMicrotask(() => this.#finish(null, signal));
		return true;
	}

	#consume(chunk: string): void {
		for (const line of chunk.split("\n").filter(Boolean)) {
			const decoded = decodeBridgeFrame(`${line}\n`);
			if (!decoded.ok) continue;
			if (decoded.message.type === "run") {
				this.runCellIds.push(decoded.message.cellId);
				this.#onRun(decoded.message.cellId);
			}
			if (decoded.message.type === "close") this.#finish(0, null);
		}
	}

	#finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.exited = true;
		this.stdout.end();
		this.stderr.end();
		this.emit("exit", code, signal);
	}
}

export interface QueueKernelFixture {
	readonly kernel: EvalKernel;
	/** Resolves once cell A is the active run, parked on its host bridge call. */
	readonly held: Promise<void>;
	/** Releases cell A: replies to its bridge call, or emits A's result on a faked interpreter. */
	readonly release: () => void;
	readonly code: string;
	readonly sentinelCode: string;
	readonly sentinel: string;
	/** What the kernel-level (session) callback observed. */
	readonly lifecycle: KernelToHostMessage[];
	readonly child: QueueSubprocess | undefined;
}

function cellCode(language: EvalLanguage): string {
	return language === "py"
		? "queue_value = tool.queue_barrier({})\nprint('A-after')\nqueue_value"
		: "const queueValue = await tool.queue_barrier({}); print('A-after'); queueValue";
}

function sentinelCell(language: EvalLanguage, sentinel: string): string {
	const path = JSON.stringify(sentinel);
	return language === "py"
		? `open(${path}, 'w').write('ran')`
		: `const fs = await import('node:fs'); fs.writeFileSync(${path}, 'ran'); 'ran'`;
}

/**
 * Runs `scenario` against a kernel of `language` whose cell A is parked on a host bridge call, so the
 * test can queue real cells behind a genuinely active run. js/py drive their real runtimes; rb/jl drive
 * `QueueSubprocess` so no ruby/julia binary is needed and interpreter retirement stays observable.
 */
export async function withQueueKernel(
	language: EvalLanguage,
	scenario: (fixture: QueueKernelFixture) => Promise<void>,
): Promise<void> {
	const cwd = await mkdtemp(join(process.cwd(), ".queue-control-"));
	const sentinel = join(cwd, "queued-ran");
	const arrived = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const lifecycle: KernelToHostMessage[] = [];
	const onMessage = (message: KernelToHostMessage): void => {
		lifecycle.push(message);
	};
	const bridge = await startBridgeServer({
		onCall: async () => {
			arrived.resolve();
			await released.promise;
			return 42;
		},
		onEmit: async () => undefined,
		onCompletion: async () => "unused",
	});
	const connection = { port: bridge.port, token: bridge.token };
	let kernel: EvalKernel | undefined;
	let child: QueueSubprocess | undefined;
	let release = (): void => released.resolve();
	try {
		const sessionId = `queue-${language}`;
		if (language === "js") {
			const js = new JavaScriptKernel({ sessionId, cwd, parallelPoolWidth: 1, onMessage });
			kernel = js;
			void js.nextToolCall().then((call) => {
				release = (): void => js.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value: 42 });
				arrived.resolve();
			});
		} else if (language === "py") {
			const detected = await createInterpreterDetector().detect("py");
			if (!detected.ok) throw new Error("Python is required for queue routing verification");
			kernel = await PythonKernel.start({ interpreterPath: detected.path, sessionId, cwd, connection, onMessage });
		} else {
			const fake = new QueueSubprocess(() => arrived.resolve());
			child = fake;
			const spawn = (): QueueSubprocess => fake;
			const options = { cwd, sessionId, connection, spawn, onMessage };
			kernel = language === "rb" ? RubyKernel.start(options) : JuliaKernel.start(options);
			fake.emitMessage({ type: "ready" });
			release = (): void =>
				fake.emitMessage({ type: "result", cellId: "A", ok: true, valueRepr: "42", durationMs: 1 });
		}
		await scenario({
			kernel,
			held: arrived.promise,
			release: () => release(),
			code: cellCode(language),
			sentinelCode: sentinelCell(language, sentinel),
			sentinel,
			lifecycle,
			child,
		});
	} finally {
		released.resolve();
		await kernel?.close();
		await bridge.close();
		await rm(cwd, { recursive: true, force: true });
		expect(existsSync(cwd)).toBe(false);
		if (child) expect(child.exited).toBe(true);
	}
}
