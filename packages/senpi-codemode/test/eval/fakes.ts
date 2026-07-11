import { DEFAULT_COMPACTION_SETTINGS, type ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../../src/bridge/protocol.ts";
import type { EvalKernel, EvalKernelManager } from "../../src/tool/eval-tool.ts";
import type { EvalKernelRunInput } from "../../src/tool/types.ts";

type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;

export class Deferred<T> {
	readonly promise: Promise<T>;
	resolve: (value: T) => void = () => {
		throw new Error("Deferred resolved before initialization");
	};
	reject: (reason?: unknown) => void = () => {
		throw new Error("Deferred rejected before initialization");
	};

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

export class FakeKernel implements EvalKernel {
	readonly replies: unknown[] = [];
	readonly runs: Array<{ cellId: string; code: string; timeoutMs?: number }> = [];
	readonly interrupts: Array<string | undefined> = [];
	resetCount = 0;
	closeCount = 0;
	private readonly messages: KernelToHostMessage[];
	private deferredRun: { readonly started: Deferred<void>; readonly result: Deferred<KernelResult> } | undefined;

	constructor(messages: KernelToHostMessage[]) {
		this.messages = messages;
	}

	replaceMessages(messages: KernelToHostMessage[]): void {
		this.messages.splice(0, this.messages.length, ...messages);
	}

	deferNextRun(): Promise<void> {
		const started = new Deferred<void>();
		this.deferredRun = { started, result: new Deferred<KernelResult>() };
		return started.promise;
	}

	async run(input: {
		cellId: string;
		code: string;
		timeoutMs?: number;
	}): Promise<Extract<KernelToHostMessage, { type: "result" }>> {
		this.runs.push(input);
		for (const message of this.messages) {
			if (message.type !== "result") this.onMessage?.(message);
		}
		const result = this.messages.find(
			(message): message is Extract<KernelToHostMessage, { type: "result" }> => message.type === "result",
		);
		if (this.deferredRun) {
			this.deferredRun.started.resolve(undefined);
			return this.deferredRun.result.promise;
		}
		if (!result) throw new Error("fake kernel missing result");
		return result;
	}

	async interrupt(reason?: string): Promise<void> {
		this.interrupts.push(reason);
		const deferredRun = this.deferredRun;
		const activeRun = this.runs.at(-1);
		if (!deferredRun || !activeRun) return;
		this.deferredRun = undefined;
		deferredRun.result.resolve({
			type: "result",
			cellId: activeRun.cellId,
			ok: false,
			error: { message: reason ?? "Eval interrupted" },
			durationMs: 0,
		});
	}

	deliverToolReply(message: unknown): void {
		this.replies.push(message);
	}

	async reset(): Promise<void> {
		this.resetCount++;
	}

	async close(): Promise<void> {
		this.closeCount++;
	}

	onMessage: ((message: KernelToHostMessage) => void) | undefined;
}

export class FakeManager implements EvalKernelManager {
	readonly kernels = new Map<string, FakeKernel>();

	constructor(entries: Array<readonly [string, FakeKernel]>) {
		for (const [language, kernel] of entries) this.kernels.set(language, kernel);
	}

	async getKernel(language: string, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel> {
		const kernel = this.kernels.get(language);
		if (!kernel) throw new Error(`missing fake kernel ${language}`);
		kernel.onMessage = onMessage;
		return kernel;
	}
}

export class DelayedKernelManager implements EvalKernelManager {
	readonly requested = new Deferred<void>();
	readonly acquired = new Deferred<EvalKernel>();

	async getKernel(): Promise<EvalKernel> {
		this.requested.resolve(undefined);
		return await this.acquired.promise;
	}
}

export class DelayedResetKernel extends FakeKernel {
	readonly resetStarted = new Deferred<void>();
	readonly resetReleased = new Deferred<void>();

	override async reset(): Promise<void> {
		this.resetStarted.resolve(undefined);
		await this.resetReleased.promise;
	}
}

export class PendingInterruptKernel implements EvalKernel {
	readonly runStarted = new Deferred<void>();
	readonly runResult = new Deferred<KernelResult>();
	readonly interruptStarted = new Deferred<void>();
	readonly interruptResult = new Deferred<void>();
	readonly interrupts: Array<string | undefined> = [];

	async run(): Promise<KernelResult> {
		this.runStarted.resolve(undefined);
		return await this.runResult.promise;
	}

	async interrupt(reason?: string): Promise<void> {
		this.interrupts.push(reason);
		this.interruptStarted.resolve(undefined);
		await this.interruptResult.promise;
	}

	deliverToolReply(): void {}

	async reset(): Promise<void> {}

	async close(): Promise<void> {}
}

export class KernelOwnedTimeoutKernel implements EvalKernel {
	readonly runStarted = new Deferred<void>();
	readonly interrupts: Array<string | undefined> = [];

	async run(input: EvalKernelRunInput): Promise<KernelResult> {
		const timeoutMs = input.timeoutMs;
		if (timeoutMs === undefined) throw new Error("expected a kernel timeout");
		this.runStarted.resolve(undefined);
		return await new Promise<KernelResult>((resolve) => {
			setTimeout(() => {
				resolve({
					type: "result",
					cellId: input.cellId,
					ok: false,
					error: { message: `Kernel timed out after ${timeoutMs}ms` },
					durationMs: timeoutMs,
				});
			}, timeoutMs);
		});
	}

	async interrupt(reason?: string): Promise<void> {
		this.interrupts.push(reason);
	}

	deliverToolReply(): void {}

	async reset(): Promise<void> {}

	async close(): Promise<void> {}
}

export class SingleKernelManager implements EvalKernelManager {
	readonly kernel: EvalKernel;

	constructor(kernel: EvalKernel) {
		this.kernel = kernel;
	}

	async getKernel(): Promise<EvalKernel> {
		return this.kernel;
	}
}

export function result(
	cellId: string,
	valueRepr: string,
	durationMs = 5,
): Extract<KernelToHostMessage, { type: "result" }> {
	return { type: "result", cellId, ok: true, valueRepr, durationMs };
}

export function errorResult(cellId: string, message: string): Extract<KernelToHostMessage, { type: "result" }> {
	return { type: "result", cellId, ok: false, error: { message }, durationMs: 5 };
}

export function fakeExtensionContext(): ExtensionContext {
	return {
		ui: Object.create(null),
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: Object.create(null),
		modelRegistry: Object.create(null),
		model: undefined,
		serviceTier: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		compact: () => {},
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getSystemPrompt: () => "",
	};
}
