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
	readonly sessionEnv?: JavaScriptKernelOptions["sessionEnv"];
	readonly workerEntryUrl?: JavaScriptKernelOptions["workerEntryUrl"];
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
		...(options.sessionEnv === undefined ? {} : { sessionEnv: options.sessionEnv }),
		...(options.workerEntryUrl === undefined ? {} : { workerEntryUrl: options.workerEntryUrl }),
	});
	try {
		return await run(kernel);
	} finally {
		await kernel.close();
	}
}

/**
 * No cell deadline: the cell's result is the event a test awaits, and the test's own timeout is the only bound. A
 * wall-clock cell deadline fails a cell whenever a loaded host keeps the kernel off the CPU that long (#5179); pass it
 * wherever the deadline is not the behaviour under test.
 */
export const NO_CELL_DEADLINE = 0;

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
