import type { ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeServerHandle, BridgeServerOptions } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { CompletionResult } from "../src/completion/handler.ts";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import type { PythonKernelStartOptions } from "../src/kernels/py/kernel.ts";
import type { EvalKernel, EvalKernelRunInput } from "../src/tool/types.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

interface SessionManagerHarness {
	bridgeOptions: BridgeServerOptions | undefined;
	bridgeCloseCount: number;
	startKernel: (onMessage: (message: KernelToHostMessage) => void) => Promise<EvalKernel>;
}

class FixtureError extends Error {
	readonly name = "FixtureError";
}

class FakeKernel implements EvalKernel {
	readonly closeStarted = Promise.withResolvers<void>();
	readonly #closeGate: Promise<void> | undefined;
	readonly #lifecycleEvents: string[] | undefined;
	readonly #closeFailure: Error | undefined;
	closeCount = 0;

	constructor(closeGate?: Promise<void>, lifecycleEvents?: string[], closeFailure?: Error) {
		this.#closeGate = closeGate;
		this.#lifecycleEvents = lifecycleEvents;
		this.#closeFailure = closeFailure;
	}

	async run(input: EvalKernelRunInput): Promise<{
		readonly type: "result";
		readonly cellId: string;
		readonly ok: true;
		readonly durationMs: number;
	}> {
		return { type: "result", cellId: input.cellId, ok: true, durationMs: 0 };
	}

	async interrupt(): Promise<void> {}

	deliverToolReply(): void {}

	async reset(): Promise<void> {}

	async close(): Promise<void> {
		this.closeCount++;
		this.#lifecycleEvents?.push("close-started");
		this.closeStarted.resolve();
		await this.#closeGate;
		if (this.#closeFailure) throw this.#closeFailure;
		this.#lifecycleEvents?.push("close-finished");
	}
}

const harness = vi.hoisted(
	(): SessionManagerHarness => ({
		bridgeOptions: undefined,
		bridgeCloseCount: 0,
		startKernel: async () => {
			throw new FixtureError("kernel start was not configured");
		},
	}),
);

vi.mock("../src/bridge/http-server.ts", () => ({
	startBridgeServer: async (options: BridgeServerOptions): Promise<BridgeServerHandle> => {
		harness.bridgeOptions = options;
		return {
			port: 31337,
			token: "test-token",
			close: async () => {
				harness.bridgeCloseCount++;
			},
		};
	},
}));

vi.mock("../src/kernels/py/kernel.ts", () => ({
	PythonKernel: {
		start: async (options: PythonKernelStartOptions): Promise<EvalKernel> => {
			return await harness.startKernel(options.onMessage ?? (() => undefined));
		},
	},
}));

const availability: InterpreterAvailability = {
	js: { enabled: false, detected: { ok: false } },
	py: { enabled: true, detected: { ok: true, path: "python", version: "3" } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

describe("codemode session manager lifecycle", () => {
	const managers: CodemodeSessionManager[] = [];

	beforeEach(() => {
		harness.bridgeOptions = undefined;
		harness.bridgeCloseCount = 0;
		harness.startKernel = async () => {
			throw new FixtureError("kernel start was not configured");
		};
	});

	afterEach(async () => {
		await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
	});

	it("reuses one created kernel and closes it during normal dispose", async () => {
		// Given
		const kernel = new FakeKernel();
		let startCount = 0;
		harness.startKernel = async () => {
			startCount++;
			return kernel;
		};
		const manager = await createManager(managers);

		// When
		const first = await manager.getKernel("py", () => undefined);
		const second = await manager.getKernel("py", () => undefined);
		await manager.dispose();

		// Then
		expect(second).toBe(first);
		expect(startCount).toBe(1);
		expect(kernel.closeCount).toBe(1);
		expect(harness.bridgeCloseCount).toBe(1);
	});

	it("shares exactly one in-flight creation across concurrent first use", async () => {
		// Given
		const creation = deferred<EvalKernel>();
		const kernel = new FakeKernel();
		let startCount = 0;
		harness.startKernel = () => {
			startCount++;
			return creation.promise;
		};
		const manager = await createManager(managers);

		// When
		const first = manager.getKernel("py", () => undefined);
		const second = manager.getKernel("py", () => undefined);
		creation.resolve(kernel);

		// Then
		await expect(Promise.all([first, second])).resolves.toEqual([kernel, kernel]);
		expect(startCount).toBe(1);
	});

	it("invalidates a delayed creation and closes its stale kernel during dispose", async () => {
		// Given
		const creation = deferred<EvalKernel>();
		const closeGate = deferred<void>();
		const lifecycleEvents: string[] = [];
		const kernel = new FakeKernel(closeGate.promise, lifecycleEvents);
		harness.startKernel = () => creation.promise;
		const manager = await createManager(managers);
		const pendingKernel = manager.getKernel("py", () => undefined);
		const creationSettlement = pendingKernel.then(
			() => lifecycleEvents.push("creation-returned"),
			() => lifecycleEvents.push("creation-rejected"),
		);

		// When
		const disposal = manager.dispose();
		await Promise.resolve();
		const bridgeClosedBeforeCreation = harness.bridgeCloseCount;
		creation.resolve(kernel);
		const firstLifecycleEvent = await Promise.race([
			kernel.closeStarted.promise.then(() => "close-started"),
			creationSettlement.then(() => "creation-settled"),
		]);
		closeGate.resolve();
		await creationSettlement;
		await disposal;

		// Then
		expect(bridgeClosedBeforeCreation).toBe(0);
		expect(firstLifecycleEvent).toBe("close-started");
		expect(lifecycleEvents).toEqual(["close-started", "close-finished", "creation-rejected"]);
		expect(kernel.closeCount).toBe(1);
		expect(harness.bridgeCloseCount).toBe(1);
		await expect(manager.getKernel("py", () => undefined)).rejects.toThrow("disposed");
	});

	it("closes the bridge and clears completion context before surfacing a kernel close failure", async () => {
		// Given
		const closeFailure = new FixtureError("kernel close failed");
		const kernel = new FakeKernel(undefined, undefined, closeFailure);
		harness.startKernel = async () => kernel;
		const manager = await createManager([]);
		manager.setContext?.(extensionContext(new AbortController().signal));
		await manager.getKernel("py", () => undefined);

		// When
		const [outcome] = await Promise.allSettled([manager.dispose()]);

		// Then
		expect.soft(harness.bridgeCloseCount).toBe(1);
		await expect(
			bridgeOptions().onCompletion({ prompt: "after dispose", signal: new AbortController().signal }),
		).rejects.toThrow("context is unavailable");
		expect(outcome?.status).toBe("rejected");
		if (outcome?.status !== "rejected") throw new FixtureError("session disposal unexpectedly succeeded");
		expect(outcome.reason).toBeInstanceOf(AggregateError);
		if (!(outcome.reason instanceof AggregateError))
			throw new FixtureError("session disposal error was not aggregated");
		expect(outcome.reason.errors).toEqual([closeFailure]);
	});

	it("aborts subprocess completion when the request signal aborts", async () => {
		// Given
		const request = new AbortController();
		const outer = new AbortController();
		const receivedSignals: AbortSignal[] = [];
		const manager = await createManager(managers, abortingCompletion(receivedSignals));
		manager.setContext?.(extensionContext(outer.signal));
		const completion = bridgeOptions().onCompletion({ prompt: "hello", signal: request.signal });
		const settlement = Promise.allSettled([completion]);

		// When
		request.abort();
		const requestCancelledCompletion = receivedSignals[0]?.aborted;
		outer.abort();
		const [outcome] = await settlement;

		// Then
		expect(requestCancelledCompletion).toBe(true);
		expect(outcome?.status).toBe("rejected");
	});

	it("aborts subprocess completion when the stored outer signal aborts", async () => {
		// Given
		const request = new AbortController();
		const outer = new AbortController();
		const receivedSignals: AbortSignal[] = [];
		const manager = await createManager(managers, abortingCompletion(receivedSignals));
		manager.setContext?.(extensionContext(outer.signal));
		const completion = bridgeOptions().onCompletion({ prompt: "hello", signal: request.signal });
		const settlement = Promise.allSettled([completion]);

		// When
		outer.abort();
		const [outcome] = await settlement;

		// Then
		expect(receivedSignals[0]?.aborted).toBe(true);
		expect(outcome?.status).toBe("rejected");
	});
});

function deferred<T>() {
	return Promise.withResolvers<T>();
}

async function createManager(
	managers: CodemodeSessionManager[],
	complete: (request: unknown, ctx: ExtensionContext) => Promise<CompletionResult> = async () => ({
		text: "ok",
		details: { model: "fake/model", structured: false },
	}),
): Promise<CodemodeSessionManager> {
	const manager = await createCodemodeSessionManager({
		sessionId: "session",
		cwd: "/tmp",
		settings: defaultCodemodeSettings,
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete,
	});
	managers.push(manager);
	return manager;
}

function abortingCompletion(
	receivedSignals: AbortSignal[],
): (request: unknown, ctx: ExtensionContext) => Promise<CompletionResult> {
	return async (_request, ctx) => {
		const signal = ctx.signal;
		if (!signal) throw new FixtureError("completion context had no signal");
		receivedSignals.push(signal);
		return await new Promise<CompletionResult>((_resolve, reject) => {
			const rejectAbort = (): void => reject(new FixtureError("completion aborted"));
			if (signal.aborted) rejectAbort();
			else signal.addEventListener("abort", rejectAbort, { once: true });
		});
	};
}

function extensionContext(signal: AbortSignal): ExtensionContext {
	return { ...fakeExtensionContext(), signal };
}

function bridgeOptions(): BridgeServerOptions {
	const options = harness.bridgeOptions;
	if (!options) throw new FixtureError("bridge server was not started");
	return options;
}
