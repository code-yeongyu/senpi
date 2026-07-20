import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionSink,
} from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

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

function jsonLines(chunks: readonly string[]): unknown[] {
	return chunks
		.flatMap((chunk) => chunk.split("\n"))
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

function isEventType(value: unknown, type: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string" &&
		value.type === type
	);
}

function eventSignal(type: string): {
	readonly observe: (chunk: string) => void;
	readonly wait: (timeoutMs: number) => Promise<void>;
} {
	let resolveEvent = () => {};
	const event = new Promise<void>((resolve) => {
		resolveEvent = resolve;
	});
	return {
		observe(chunk) {
			if (jsonLines([chunk]).some((line) => isEventType(line, type))) {
				resolveEvent();
			}
		},
		wait(timeoutMs) {
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`Timed out waiting for ${type} over RPC JSONL`)),
					timeoutMs,
				);
				void event.then(
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
		},
	};
}

function createHandler(
	harness: Harness,
	chunks: string[],
	signal: ReturnType<typeof eventSignal>,
): RpcConnectionHandler {
	const sink: RpcConnectionSink = {
		writeRaw(chunk) {
			chunks.push(chunk);
			signal.observe(chunk);
		},
		waitForBackpressure: async () => {},
	};
	return createRpcConnectionHandler(createRuntimeHost(harness.session), sink);
}

function refusal(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(text, {
		stopReason: "error",
		errorMessage: "misleading_success_output",
		stopDetails: { type: "refusal" },
	});
}

describe("RPC fallback events", () => {
	const harnesses: Harness[] = [];
	const handlers: RpcConnectionHandler[] = [];

	afterEach(async () => {
		while (handlers.length > 0) await handlers.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("streams applied and succeeded fallback events over JSONL", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback answer"),
		]);

		const chunks: string[] = [];
		const succeeded = eventSignal("retry_fallback_succeeded");
		const handler = createHandler(harness, chunks, succeeded);
		handlers.push(handler);
		await handler.ready;

		await handler.handleInputLine(JSON.stringify({ id: "fallback-success", type: "prompt", message: "hello" }));
		await succeeded.wait(2_000);

		const events = jsonLines(chunks);
		expect(events).toContainEqual({
			type: "retry_fallback_applied",
			from: primary,
			to: fallback,
			chainKey: primary,
			reason: "transient",
		});
		expect(events).toContainEqual({ type: "retry_fallback_succeeded", model: fallback, chainKey: primary });
	});

	it("streams fallback exhaustion over JSONL", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([refusal("primary refusal"), refusal("fallback refusal")]);

		const chunks: string[] = [];
		const exhausted = eventSignal("retry_fallback_exhausted");
		const handler = createHandler(harness, chunks, exhausted);
		handlers.push(handler);
		await handler.ready;

		await handler.handleInputLine(JSON.stringify({ id: "fallback-exhausted", type: "prompt", message: "hello" }));
		await exhausted.wait(2_000);

		expect(jsonLines(chunks)).toContainEqual({
			type: "retry_fallback_exhausted",
			chainKey: primary,
			lastError: "misleading_success_output",
		});
	});
});
