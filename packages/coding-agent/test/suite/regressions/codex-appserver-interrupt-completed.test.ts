import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcEnvelope } from "../../../src/modes/app-server/rpc/envelope.ts";
import { createAppServerRuntime } from "../../../src/modes/app-server/runtime.ts";
import { configureModeEnv, createDeferred, scratchRoot, seedFauxConfig } from "../app-server-mode-harness.ts";

const runtimes: Array<ReturnType<typeof createAppServerRuntime>> = [];
const fauxProviders: Array<{ unregister(): void }> = [];

describe("codex app-server interrupt -> turn/completed(interrupted)", () => {
	afterEach(() => {
		while (runtimes.length > 0) {
			runtimes.pop()?.dispose();
		}
		while (fauxProviders.length > 0) {
			fauxProviders.pop()?.unregister();
		}
	});

	it("writes the turn/interrupt response before turn/completed interrupted with emittedAtMs", async () => {
		// Given: an in-process app-server whose faux provider is held mid-turn.
		const providerEntered = createDeferred();
		const hold = createDeferred();
		const client = await startClient({
			schedulerHook: async () => {
				providerEntered.resolve();
				await hold.promise;
			},
			assistantText: "should not finish before interrupt",
		});
		try {
			const { threadId, turnId } = await startGatedTurn(client, providerEntered);

			// When: the client interrupts the still-active turn.
			const interruptStartedAt = client.frames.length;
			await client.request(5, "turn/interrupt", { threadId, turnId });

			// Then: the interrupt RPC result precedes turn/completed(interrupted) and the notification is stamped.
			const interruptSlice = client.frames.slice(interruptStartedAt);
			const responseIndex = interruptSlice.findIndex((frame) => "id" in frame && frame.id === 5);
			const completedIndex = interruptSlice.findIndex(isTurnCompleted);
			expect(responseIndex).toBeGreaterThan(-1);
			expect(completedIndex).toBeGreaterThan(responseIndex);
			expect(interruptSlice[responseIndex]).toEqual({ id: 5, result: {} });
			const completed = interruptSlice[completedIndex];
			expect(completed).toMatchObject({
				method: "turn/completed",
				params: {
					threadId,
					turn: { id: turnId, status: "interrupted" },
				},
			});
			expect(isStampedNotification(completed)).toBe(true);
			expect(interruptSlice.some(isTurnAborted)).toBe(false);
		} finally {
			hold.resolve();
		}
	});

	it("still emits turn/completed with status completed on a normal finish", async () => {
		// Given: an in-process app-server whose faux provider will finish the turn.
		const client = await startClient({ assistantText: "normal completion" });
		const completed = client.frames.waitUntil(isTurnCompleted);

		// When: a turn starts and the faux provider is allowed to finish.
		const started = await startTurn(client, "finish normally");

		// Then: the terminal notification stays completed and is still stamped.
		const notification = await completed;
		expect(notification).toMatchObject({
			method: "turn/completed",
			params: {
				threadId: started.threadId,
				turn: { id: started.turnId, status: "completed" },
			},
		});
		expect(isStampedNotification(notification)).toBe(true);
		expect(client.frames.some(isTurnAborted)).toBe(false);
	});

	it("returns a no-op interrupt result without a spurious turn/completed when no turn is active", async () => {
		// Given: a subscribed idle thread with no active turn.
		const client = await startClient({ assistantText: "unused" });
		const threadId = await startThread(client);

		// When: the client interrupts a turn that is not running.
		const interruptStartedAt = client.frames.length;
		await client.request(4, "turn/interrupt", { threadId, turnId: "no-active-turn" });

		// Then: the documented no-op result is returned and no terminal turn notification is synthesized.
		const interruptSlice = client.frames.slice(interruptStartedAt);
		expect(interruptSlice.filter((frame) => "id" in frame && frame.id === 4)).toEqual([{ id: 4, result: {} }]);
		expect(interruptSlice.some(isTurnCompleted)).toBe(false);
		expect(interruptSlice.some(isTurnAborted)).toBe(false);
		expect(client.frames.some(isTurnCompleted)).toBe(false);
	});
});

type Client = {
	readonly runtime: ReturnType<typeof createAppServerRuntime>;
	readonly faux: ReturnType<typeof registerFauxProvider>;
	readonly frames: FrameSink;
	readonly root: string;
	request(id: number, method: string, params?: unknown): Promise<void>;
};

async function startClient(options: {
	readonly assistantText: string;
	readonly schedulerHook?: () => void | Promise<void>;
}): Promise<Client> {
	const root = await scratchRoot();
	const faux = registerFauxProvider({ schedulerHook: options.schedulerHook });
	faux.setResponses([fauxAssistantMessage(options.assistantText)]);
	await seedFauxConfig(root, faux);
	configureModeEnv(root);
	const runtime = createAppServerRuntime(() => undefined);
	runtimes.push(runtime);
	fauxProviders.push(faux);
	const frames = new FrameSink();
	const connection = runtime.core.addConnection({
		id: "interrupt-client",
		transportKind: "stdio",
		send: (message) => {
			frames.push(message);
		},
		close: () => undefined,
	});
	const request = async (id: number, method: string, params?: unknown): Promise<void> => {
		await runtime.core.receive(connection.id, { kind: "request", message: { id, method, params } });
	};
	await request(1, "initialize", {
		clientInfo: { name: "codex-interrupt-pin", title: "Codex interrupt pin", version: "0.0.1" },
		capabilities: { experimentalApi: true, requestAttestation: false },
	});
	return { runtime, faux, frames, root, request };
}

async function startThread(client: Client): Promise<string> {
	await client.request(2, "thread/start", { cwd: client.root });
	return threadIdFromResponse(client.frames.mustFind((frame) => "id" in frame && frame.id === 2));
}

async function startTurn(client: Client, text: string): Promise<{ readonly threadId: string; readonly turnId: string }> {
	const threadId = await startThread(client);
	await client.request(3, "turn/start", { threadId, input: [{ type: "text", text }] });
	const turnId = turnIdFromResponse(client.frames.mustFind((frame) => "id" in frame && frame.id === 3));
	return { threadId, turnId };
}

async function startGatedTurn(
	client: Client,
	providerEntered: { readonly promise: Promise<void> },
): Promise<{ readonly threadId: string; readonly turnId: string }> {
	const started = await startTurn(client, "interrupt me");
	await withTimeout(providerEntered.promise, "faux provider did not enter the gated stream");
	return started;
}

function isTurnCompleted(frame: RpcEnvelope): frame is RpcEnvelope & {
	readonly method: "turn/completed";
	readonly emittedAtMs?: number;
} {
	return "method" in frame && !("id" in frame) && frame.method === "turn/completed";
}

function isTurnAborted(frame: RpcEnvelope): boolean {
	return "method" in frame && frame.method === "turn/aborted";
}

function isStampedNotification(frame: RpcEnvelope | undefined): boolean {
	return frame !== undefined && "emittedAtMs" in frame && Number.isFinite(frame.emittedAtMs);
}

function threadIdFromResponse(frame: RpcEnvelope): string {
	return stringAt(objectAt(successResult(frame), "thread"), "id");
}

function turnIdFromResponse(frame: RpcEnvelope): string {
	return stringAt(objectAt(successResult(frame), "turn"), "id");
}

function successResult(frame: RpcEnvelope): Record<string, unknown> {
	if (!("result" in frame)) {
		throw new Error("expected JSON-RPC success response");
	}
	return objectValue(frame.result);
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
	return objectValue(value[key]);
}

function stringAt(value: Record<string, unknown>, key: string): string {
	const child = value[key];
	if (typeof child !== "string") {
		throw new Error(`Expected ${key} to be a string`);
	}
	return child;
}

function objectValue(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected an object");
	}
	return Object.fromEntries(Object.entries(value));
}

function withTimeout(promise: Promise<void>, message: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(message)), 5_000);
		promise.then(
			() => {
				clearTimeout(timeout);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

class FrameSink {
	readonly frames: RpcEnvelope[] = [];
	private readonly listeners = new Set<(frame: RpcEnvelope) => void>();

	get length(): number {
		return this.frames.length;
	}

	push(frame: RpcEnvelope): void {
		this.frames.push(frame);
		for (const listener of this.listeners) {
			listener(frame);
		}
	}

	slice(start: number): RpcEnvelope[] {
		return this.frames.slice(start);
	}

	some(predicate: (frame: RpcEnvelope) => boolean): boolean {
		return this.frames.some(predicate);
	}

	mustFind(predicate: (frame: RpcEnvelope) => boolean): RpcEnvelope {
		const frame = this.frames.find(predicate);
		if (frame === undefined) {
			throw new Error("expected matching frame");
		}
		return frame;
	}

	waitUntil(predicate: (frame: RpcEnvelope) => boolean): Promise<RpcEnvelope> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.listeners.delete(onFrame);
				reject(new Error("expected frame was not observed"));
			}, 5_000);
			const onFrame = (frame: RpcEnvelope): void => {
				if (!predicate(frame)) {
					return;
				}
				clearTimeout(timeout);
				this.listeners.delete(onFrame);
				resolve(frame);
			};
			this.listeners.add(onFrame);
			for (const existing of this.frames) {
				onFrame(existing);
			}
		});
	}
}
