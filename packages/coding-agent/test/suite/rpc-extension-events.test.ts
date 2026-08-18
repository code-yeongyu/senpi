import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { RpcClientEvent, RpcEventListener, RpcExtensionEvent } from "../../src/index.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionOptions,
	type RpcConnectionSink,
} from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

type ExtensionRpcApi = ExtensionAPI & {
	readonly rpc?: {
		emit(name: string, data: unknown): void;
	};
};

type RpcRecord = Record<string, unknown>;

const publicListener: RpcEventListener = (event) => {
	if (event.type !== "extension_event") return;
	const extensionEvent: RpcExtensionEvent = event;
	void extensionEvent.name;
};
const publicEvent: RpcClientEvent = {
	type: "extension_event",
	name: "fixture.public",
	data: null,
};
void publicListener;
void publicEvent;

function createRuntimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
}

function records(chunks: readonly string[]): RpcRecord[] {
	return chunks
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RpcRecord);
}

async function extensionHarness(): Promise<{
	harness: Harness;
	emitRpc(name: string, data: unknown): void;
}> {
	let api: ExtensionRpcApi | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi as ExtensionRpcApi;
			},
		],
	});
	if (!api) throw new Error("Extension factory did not receive its API");
	return {
		harness,
		emitRpc(name, data) {
			if (!api?.rpc) throw new Error("Extension factory did not receive the RPC API");
			api.rpc.emit(name, data);
		},
	};
}

function connect(harness: Harness, chunks: string[], options: RpcConnectionOptions = {}): RpcConnectionHandler {
	const sink: RpcConnectionSink = {
		writeRaw: (chunk) => chunks.push(chunk),
		waitForBackpressure: async () => {},
	};
	return createRpcConnectionHandler(createRuntimeHost(harness.session), sink, options);
}

async function flushEvents(handler: RpcConnectionHandler): Promise<void> {
	await handler.handleInputLine(JSON.stringify({ id: "flush", type: "get_state" }));
}

function extensionEvents(chunks: readonly string[]): RpcRecord[] {
	return records(chunks).filter((record) => record.type === "extension_event");
}

describe("capability-gated extension RPC events", () => {
	const harnesses: Harness[] = [];
	const handlers: RpcConnectionHandler[] = [];

	afterEach(async () => {
		while (handlers.length > 0) await handlers.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("exposes pi.rpc.emit to extension factories", async () => {
		const { harness, emitRpc } = await extensionHarness();
		harnesses.push(harness);

		expect(() => emitRpc("fixture.ready", { ready: true })).not.toThrow();
	});

	it("emits exactly one wire event for a client with extension_events capability", async () => {
		const flagged = await extensionHarness();
		harnesses.push(flagged.harness);
		const flaggedChunks: string[] = [];
		const flaggedHandler = connect(flagged.harness, flaggedChunks, { capabilities: ["extension_events"] });
		handlers.push(flaggedHandler);
		await flaggedHandler.ready;

		flagged.emitRpc("fixture.progress", { step: 2 });
		await flushEvents(flaggedHandler);

		expect(extensionEvents(flaggedChunks)).toEqual([
			{ type: "extension_event", name: "fixture.progress", data: { step: 2 } },
		]);
	});

	it("captures extension events emitted during initial session_start binding", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const rpcApi = pi as ExtensionRpcApi;
					pi.on("session_start", () => {
						rpcApi.rpc?.emit("fixture.session-start", { ready: true });
					});
				},
			],
		});
		harnesses.push(harness);
		const chunks: string[] = [];
		const handler = connect(harness, chunks, { capabilities: ["extension_events"] });
		handlers.push(handler);
		await handler.ready;

		expect(extensionEvents(chunks)).toEqual([
			{ type: "extension_event", name: "fixture.session-start", data: { ready: true } },
		]);
	});

	it("emits no wire event for an unflagged client", async () => {
		const plain = await extensionHarness();
		harnesses.push(plain.harness);
		const plainChunks: string[] = [];
		const plainHandler = connect(plain.harness, plainChunks);
		handlers.push(plainHandler);
		await plainHandler.ready;

		plain.emitRpc("fixture.progress", { step: 2 });
		await flushEvents(plainHandler);

		expect(extensionEvents(plainChunks)).toEqual([]);
	});

	it("tags extension events with the owning multi-session routing id", async () => {
		const { harness, emitRpc } = await extensionHarness();
		harnesses.push(harness);
		const chunks: string[] = [];
		const handler = connect(harness, chunks, {
			capabilities: ["extension_events"],
			sessionId: "rpc-session-beta",
		});
		handlers.push(handler);
		await handler.ready;

		emitRpc("fixture.session", { owner: "beta" });
		await flushEvents(handler);

		expect(extensionEvents(chunks)).toEqual([
			{
				type: "extension_event",
				name: "fixture.session",
				data: { owner: "beta" },
				sessionId: "rpc-session-beta",
			},
		]);
	});
});
