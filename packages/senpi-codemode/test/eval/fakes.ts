import type { KernelToHostMessage } from "../../src/bridge/protocol.ts";
import type { EvalKernel, EvalKernelManager } from "../../src/tool/eval-tool.ts";

export class FakeKernel implements EvalKernel {
	readonly replies: unknown[] = [];
	readonly runs: Array<{ cellId: string; code: string; timeoutMs?: number }> = [];
	resetCount = 0;
	closeCount = 0;
	private readonly messages: KernelToHostMessage[];

	constructor(messages: KernelToHostMessage[]) {
		this.messages = messages;
	}

	replaceMessages(messages: KernelToHostMessage[]): void {
		this.messages.splice(0, this.messages.length, ...messages);
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
		if (!result) throw new Error("fake kernel missing result");
		return result;
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
