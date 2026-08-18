import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { RpcClient } from "../../src/index.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionOptions,
	type RpcConnectionSink,
} from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

type ExtensionRequestHandler = (data: unknown) => unknown | Promise<unknown>;

type ExtensionRequestApi = ExtensionAPI & {
	readonly rpc: {
		emit(name: string, data: unknown): void;
		handle(name: string, handler: ExtensionRequestHandler): void;
	};
};

type RpcRecord = Record<string, unknown>;
type PublicRequestExtension = RpcClient["requestExtension"];
const publicRequestExtension: PublicRequestExtension | undefined = undefined;
void publicRequestExtension;

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

function connect(harness: Harness, chunks: string[], options: RpcConnectionOptions = {}): RpcConnectionHandler {
	const sink: RpcConnectionSink = {
		writeRaw: (chunk) => chunks.push(chunk),
		waitForBackpressure: async () => {},
	};
	return createRpcConnectionHandler(createRuntimeHost(harness.session), sink, options);
}

async function request(
	handler: RpcConnectionHandler,
	chunks: string[],
	input: {
		readonly id: string;
		readonly name: string;
		readonly data?: unknown;
	},
): Promise<RpcRecord> {
	await handler.handleInputLine(
		JSON.stringify({
			id: input.id,
			type: "extension_request",
			name: input.name,
			...(input.data === undefined ? {} : { data: input.data }),
		}),
	);
	const response = records(chunks).find((record) => record.id === input.id);
	if (!response) throw new Error(`Missing response for ${input.id}`);
	return response;
}

describe("extension RPC requests", () => {
	const harnesses: Harness[] = [];
	const handlers: RpcConnectionHandler[] = [];

	afterEach(async () => {
		while (handlers.length > 0) await handlers.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("exposes a request handler registration API to extensions", async () => {
		let rpc: ExtensionRequestApi["rpc"] | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					rpc = (pi as ExtensionRequestApi).rpc;
				},
			],
		});
		harnesses.push(harness);

		expect(rpc?.handle).toBeTypeOf("function");
	});

	it("routes one request to its extension handler and returns structured data", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const rpc = (pi as ExtensionRequestApi).rpc;
					if (typeof rpc.handle !== "function") return;
					rpc.handle("fixture.echo", async (data) => ({ echoed: data }));
				},
			],
		});
		harnesses.push(harness);
		const chunks: string[] = [];
		const handler = connect(harness, chunks);
		handlers.push(handler);
		await handler.ready;

		await expect(
			request(handler, chunks, {
				id: "echo",
				name: "fixture.echo",
				data: { text: "hello" },
			}),
		).resolves.toEqual({
			id: "echo",
			type: "response",
			command: "extension_request",
			success: true,
			data: { echoed: { text: "hello" } },
		});
	});

	it("returns a bounded error for an unknown request name", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const chunks: string[] = [];
		const handler = connect(harness, chunks);
		handlers.push(handler);
		await handler.ready;

		const response = await request(handler, chunks, {
			id: "missing",
			name: "fixture.missing",
		});

		expect(response).toMatchObject({
			id: "missing",
			type: "response",
			command: "extension_request",
			success: false,
		});
		expect(response.error).toContain("fixture.missing");
	});

	it("rejects duplicate request handlers instead of choosing one", async () => {
		const register = (value: string) => (pi: ExtensionAPI) => {
			const rpc = (pi as ExtensionRequestApi).rpc;
			if (typeof rpc.handle !== "function") return;
			rpc.handle("fixture.duplicate", () => ({ value }));
		};
		const harness = await createHarness({
			extensionFactories: [register("first"), register("second")],
		});
		harnesses.push(harness);
		const chunks: string[] = [];
		const handler = connect(harness, chunks);
		handlers.push(handler);
		await handler.ready;

		const response = await request(handler, chunks, {
			id: "duplicate",
			name: "fixture.duplicate",
		});

		expect(response).toMatchObject({
			id: "duplicate",
			type: "response",
			command: "extension_request",
			success: false,
		});
		expect(response.error).toContain("fixture.duplicate");
	});

	it("tags the response with the owning multi-session routing id", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const rpc = (pi as ExtensionRequestApi).rpc;
					if (typeof rpc.handle !== "function") return;
					rpc.handle("fixture.owner", () => ({ owner: "beta" }));
				},
			],
		});
		harnesses.push(harness);
		const chunks: string[] = [];
		const handler = connect(harness, chunks, { sessionId: "rpc-session-beta" });
		handlers.push(handler);
		await handler.ready;

		await expect(
			request(handler, chunks, {
				id: "owner",
				name: "fixture.owner",
			}),
		).resolves.toEqual({
			id: "owner",
			type: "response",
			command: "extension_request",
			success: true,
			data: { owner: "beta" },
			sessionId: "rpc-session-beta",
		});
	});

	it("rejects requests through a stale extension generation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const rpc = (pi as ExtensionRequestApi).rpc;
					if (typeof rpc.handle !== "function") return;
					rpc.handle("fixture.stale", () => ({ stale: false }));
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.session.extensionRunner;
		runner.invalidate("stale extension generation");

		await expect(runner.requestRpc("fixture.stale", null)).rejects.toThrow("stale extension generation");
	});

	it("invalidates the previous extension generation after a real reload", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const rpc = (pi as ExtensionRequestApi).rpc;
					if (typeof rpc.handle !== "function") return;
					rpc.handle("fixture.reload", () => ({ generation: "old" }));
				},
			],
		});
		harnesses.push(harness);
		const oldRunner = harness.session.extensionRunner;

		await harness.session.reload();

		expect(harness.session.extensionRunner).not.toBe(oldRunner);
		await expect(oldRunner.requestRpc("fixture.reload", null)).rejects.toThrow("stale extension generation");
	});

	it("rejects an in-flight result when its generation becomes stale", async () => {
		const started = Promise.withResolvers<void>();
		const result = Promise.withResolvers<{ generation: string }>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const rpc = (pi as ExtensionRequestApi).rpc;
					if (typeof rpc.handle !== "function") return;
					rpc.handle("fixture.in-flight", async () => {
						started.resolve();
						return result.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.session.extensionRunner;
		const pending = runner.requestRpc("fixture.in-flight", null);
		await started.promise;

		runner.invalidate("stale extension generation");
		result.resolve({ generation: "old" });

		await expect(pending).rejects.toThrow("stale extension generation");
	});
});
