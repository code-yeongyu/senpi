import type { KernelToHostMessage } from "../../src/bridge/protocol.ts";
import { JavaScriptKernel, type JavaScriptKernelOptions } from "../../src/kernels/js/context-manager.ts";

export interface CapturedJavaScriptRun {
	readonly result: Extract<KernelToHostMessage, { type: "result" }>;
	readonly messages: readonly KernelToHostMessage[];
}

export interface JavaScriptKernelHarnessOptions {
	readonly cwd?: string;
	readonly localRoots?: JavaScriptKernelOptions["localRoots"];
	readonly artifactsDir?: string;
}

export async function withJavaScriptKernel<T>(
	run: (kernel: JavaScriptKernel) => Promise<T>,
	options: JavaScriptKernelHarnessOptions = {},
): Promise<T> {
	const kernel = new JavaScriptKernel({
		sessionId: `parity-${crypto.randomUUID()}`,
		cwd: options.cwd ?? process.cwd(),
		parallelPoolWidth: 2,
		...(options.localRoots === undefined ? {} : { localRoots: options.localRoots }),
		...(options.artifactsDir === undefined ? {} : { artifactsDir: options.artifactsDir }),
	});
	try {
		return await run(kernel);
	} finally {
		await kernel.close();
	}
}

export async function runJavaScriptCell(
	kernel: JavaScriptKernel,
	code: string,
	timeoutMs = 2_000,
): Promise<CapturedJavaScriptRun> {
	const messages: KernelToHostMessage[] = [];
	const result = await kernel.run({
		cellId: `parity-cell-${crypto.randomUUID()}`,
		code,
		timeoutMs,
		onMessage: (message) => messages.push(message),
	});
	return { result, messages };
}

export function parseJavaScriptResult(result: CapturedJavaScriptRun["result"]): unknown {
	if (!result.ok) throw new Error(`JavaScript parity cell failed: ${result.error.message}`);
	if (result.valueRepr === undefined) return undefined;
	const value: unknown = JSON.parse(result.valueRepr);
	return value;
}
