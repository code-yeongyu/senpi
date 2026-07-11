import { PassThrough } from "node:stream";
import {
	decodeBridgeFrame,
	encodeBridgeFrame,
	type HostToKernelMessage,
	type KernelToHostMessage,
} from "../../src/bridge/protocol.ts";
import { createInterpreterDetector } from "../../src/interpreters/detect.ts";
import { type KernelChild, PythonKernel, type PythonKernelStartOptions } from "../../src/kernels/py/kernel.ts";

export interface FakeChildOptions {
	readonly autoReady?: boolean;
	readonly autoRun?: boolean;
	readonly remainAliveOnInterrupt?: boolean;
	readonly remainAliveOnSigkill?: boolean;
	readonly rejectKill?: boolean;
	readonly throwOnInterruptFrame?: boolean;
	readonly onRun?: (message: Extract<HostToKernelMessage, { type: "run" }>) => void;
}

export class FakeChild implements KernelChild {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid: number | undefined = undefined;
	readonly runMessages: Extract<HostToKernelMessage, { type: "run" }>[] = [];
	readonly killSignals: NodeJS.Signals[] = [];
	killed = false;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly #options: FakeChildOptions;
	#finished = false;

	constructor(options: FakeChildOptions = {}) {
		this.#options = options;
		this.stdin.on("data", (chunk) => {
			const lines = String(chunk).split("\n").filter(Boolean);
			for (const line of lines) {
				const decoded = decodeBridgeFrame(`${line}\n`);
				if (!decoded.ok) continue;
				if (decoded.message.type === "run") {
					this.runMessages.push(decoded.message);
					this.#options.onRun?.(decoded.message);
				}
				if (decoded.message.type === "interrupt" && this.#options.throwOnInterruptFrame === true) {
					throw new Error("interrupt frame write failed");
				}
				if (decoded.message.type === "init" && this.#options.autoReady !== false) {
					this.emitMessage({ type: "ready" });
				}
				if (decoded.message.type === "run" && this.#options.autoRun !== false) {
					this.emitMessage({
						type: "result",
						cellId: decoded.message.cellId,
						ok: true,
						valueRepr: "fake",
						durationMs: 1,
					});
				}
				if (decoded.message.type === "close") {
					this.emitMessage({ type: "closed" });
					this.finish(0, null);
				}
			}
		});
	}

	kill(signal?: NodeJS.Signals): boolean {
		const deliveredSignal = signal ?? "SIGTERM";
		this.killSignals.push(deliveredSignal);
		if (this.#options.rejectKill === true) return false;
		this.killed = true;
		const remainsAlive =
			deliveredSignal === "SIGKILL"
				? this.#options.remainAliveOnSigkill === true
				: this.#options.remainAliveOnInterrupt === true;
		if (!remainsAlive) this.finish(null, deliveredSignal);
		return true;
	}

	emitMessage(message: KernelToHostMessage): void {
		this.stdout.emit("data", encodeBridgeFrame(message));
	}

	fail(error: Error): void {
		this.emit("error", error);
	}

	finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.#finished) return;
		this.#finished = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		this.stdin.end();
		this.stdout.emit("close");
		this.stderr.emit("close");
		this.emit("exit", code, signal);
	}

	readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

	on(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return this;
	}

	once(event: string, listener: (...args: unknown[]) => void): this {
		const wrapped = (...args: unknown[]) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	off(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
		);
		return this;
	}

	emit(event: string, ...args: unknown[]): boolean {
		const listeners = this.listeners.get(event) ?? [];
		if (event === "error" && listeners.length === 0) {
			const error = args[0];
			throw error instanceof Error ? error : new Error(String(error));
		}
		for (const listener of listeners) listener(...args);
		return true;
	}
}

export type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;

export async function startFakeKernel(child: FakeChild, sessionId: string): Promise<PythonKernel> {
	const started = PythonKernel.start({
		interpreterPath: "python3",
		sessionId,
		cwd: process.cwd(),
		connection: { port: 1, token: "t" },
		spawnProcess: () => child,
	});
	child.emitMessage({ type: "ready" });
	return await started;
}

export async function startFakeKernelSequence(
	children: readonly FakeChild[],
	sessionId: string,
	onMessage?: PythonKernelStartOptions["onMessage"],
): Promise<{ readonly kernel: PythonKernel; readonly spawned: readonly FakeChild[] }> {
	const first = children[0];
	if (!first) throw new Error("fake kernel sequence requires at least one child");
	const spawned: FakeChild[] = [];
	let nextIndex = 0;
	const started = PythonKernel.start({
		interpreterPath: "python3",
		sessionId,
		cwd: process.cwd(),
		connection: { port: 1, token: "t" },
		onMessage,
		spawnProcess: () => {
			const child = children[nextIndex];
			if (!child) throw new Error("unexpected fake Python child spawn");
			nextIndex += 1;
			spawned.push(child);
			return child;
		},
	});
	first.emitMessage({ type: "ready" });
	return { kernel: await started, spawned };
}

export async function hasPython3(): Promise<boolean> {
	const detector = createInterpreterDetector();
	return (await detector.detect("py")).ok;
}

export async function liveKernel(options: Pick<PythonKernelStartOptions, "onMessage"> = {}): Promise<PythonKernel> {
	const detector = createInterpreterDetector();
	const detected = await detector.detect("py");
	if (!detected.ok) throw new Error("python unavailable");
	return await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: "live-session",
		cwd: process.cwd(),
		connection: { port: 1, token: "unused" },
		...options,
	});
}

export async function runCell(kernel: PythonKernel, code: string): Promise<ResultMessage> {
	return await kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 3_000 });
}
