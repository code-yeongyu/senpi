import { readFileSync } from "node:fs";
import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../../src/core/agent-session-services.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#2197: a provider adapter's providerDiagnostic reaches AgentSession events, the
// persisted session JSONL, print-mode JSON events, and RPC events + get_state unchanged.

const DIAGNOSTIC: ProviderDiagnostic = {
	category: "rate_limit",
	httpStatus: 429,
	code: "rate_limit_error",
	evidence: "structured_code",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(line: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(line);
	if (!isRecord(parsed)) throw new Error(`Expected a JSON object line: ${line}`);
	return parsed;
}

function assistantDiagnostic(record: Record<string, unknown>): unknown {
	const message = record.message;
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	return message.providerDiagnostic;
}

function isAssistantRecord(record: Record<string, unknown>): boolean {
	return isRecord(record.message) && record.message.role === "assistant";
}

function createRuntime(harness: Harness): AgentSessionRuntime {
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		authStorage: harness.authStorage,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.modelRegistry,
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	return new AgentSessionRuntime(harness.session, services, async () => {
		throw new Error("provider-diagnostic propagation test does not replace sessions");
	});
}

function failedTurn(providerDiagnostic?: ProviderDiagnostic): AssistantMessage {
	const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited by provider" });
	return providerDiagnostic === undefined ? message : { ...message, providerDiagnostic };
}

describe("providerDiagnostic propagation through the session surfaces", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createRpcHarness(): Promise<{
		harness: Harness;
		send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
		records(): Record<string, unknown>[];
	}> {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const lines: string[] = [];
		const sink: RpcConnectionSink = {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		};
		const handler = createRpcConnectionHandler(createRuntime(harness), sink);
		cleanups.push(() => handler.dispose());
		await handler.ready;
		const records = (): Record<string, unknown>[] => lines.join("").split("\n").filter(Boolean).map(parseRecord);
		let sequence = 0;
		return {
			harness,
			records,
			send: async (command) => {
				const id = `rpc-${++sequence}`;
				await handler.handleInputLine(JSON.stringify({ id, ...command }));
				const response = records().find((record) => record.id === id && record.type === "response");
				if (!response) throw new Error(`Missing RPC response for ${JSON.stringify(command)}`);
				return response;
			},
		};
	}

	function stateData(response: Record<string, unknown>): Record<string, unknown> {
		if (!isRecord(response.data)) throw new Error("Expected get_state data");
		return response.data;
	}

	it("carries the diagnostic to session events, JSONL, print JSON, and RPC events + get_state", async () => {
		const rpc = await createRpcHarness();
		rpc.harness.setResponses([failedTurn(DIAGNOSTIC)]);

		await rpc.harness.session.prompt("hello");

		const assistantEnd = rpc.harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		if (assistantEnd?.message.role !== "assistant") throw new Error("Expected an assistant message_end");
		expect(assistantEnd.message.errorMessage).toBe("429 rate limited by provider");
		expect(assistantEnd.message.providerDiagnostic).toEqual(DIAGNOSTIC);

		const printed = parseRecord(JSON.stringify(toJsonEvent(assistantEnd)));
		expect(assistantDiagnostic(printed)).toEqual(DIAGNOSTIC);

		const sessionFile = rpc.harness.session.sessionFile;
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const persisted = readFileSync(sessionFile, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map(parseRecord)
			.find((entry) => entry.type === "message" && isAssistantRecord(entry));
		if (!persisted) throw new Error("Expected a persisted assistant entry");
		expect(assistantDiagnostic(persisted)).toEqual(DIAGNOSTIC);

		const wireEnd = rpc.records().find((record) => record.type === "message_end" && isAssistantRecord(record));
		if (!wireEnd) throw new Error("Expected an RPC assistant message_end");
		expect(assistantDiagnostic(wireEnd)).toEqual(DIAGNOSTIC);

		const state = stateData(await rpc.send({ type: "get_state" }));
		expect(state.lastProviderDiagnostic).toEqual(DIAGNOSTIC);
	});

	it("omits lastProviderDiagnostic when the failed turn carries none", async () => {
		const rpc = await createRpcHarness();
		rpc.harness.setResponses([failedTurn()]);

		await rpc.harness.session.prompt("hello");

		const state = stateData(await rpc.send({ type: "get_state" }));
		expect("lastProviderDiagnostic" in state).toBe(false);
	});
});
