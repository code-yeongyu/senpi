import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const RUNTIME_EVENTS = [
	"tool_activated",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
] as const;
const LOOP_EVENTS = ["agent_start", "message_start"] as const;

async function recordingRunner(sessionManager: SessionManager | undefined) {
	const seen: string[] = [];
	const record = (pi: ExtensionAPI): void => {
		pi.on("tool_activated", () => void seen.push("tool_activated"));
		pi.on("tool_execution_start", () => void seen.push("tool_execution_start"));
		pi.on("tool_execution_update", () => void seen.push("tool_execution_update"));
		pi.on("tool_execution_end", () => void seen.push("tool_execution_end"));
		pi.on("agent_start", () => void seen.push("agent_start"));
		pi.on("message_start", () => void seen.push("message_start"));
	};
	const extensions = await createTestExtensionsResult([record]);
	const runner = new ExtensionRunner(
		extensions.extensions,
		extensions.runtime,
		process.cwd(),
		sessionManager,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
		extensions.eventBus,
	);
	return { runner, seen };
}

async function emitAll(runner: ExtensionRunner): Promise<void> {
	await runner.emit({ type: "tool_activated", toolNames: ["probe"] });
	await runner.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "probe", args: {} });
	await runner.emit({
		type: "tool_execution_update",
		toolCallId: "call-1",
		toolName: "probe",
		args: {},
		partialResult: { content: [], details: {} },
	});
	await runner.emit({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "probe",
		result: { content: [], details: {} },
		isError: false,
	});
	await runner.emit({ type: "agent_start" });
	await runner.emit({ type: "message_start", message: { role: "user", content: [], timestamp: 0 } });
}

describe("runtime events without a session (RT11)", () => {
	it("delivers the runtime's own events, in order, on a runner with no session manager", async () => {
		// Given a runner built without a session manager, with handlers for runtime and loop events.
		const { runner, seen } = await recordingRunner(undefined);
		// When each event is emitted.
		await emitAll(runner);
		// Then only the runtime events reach the handlers, in emission order.
		expect(seen).toEqual([...RUNTIME_EVENTS]);
	});

	it("delivers every event to a session, as today", async () => {
		const { runner, seen } = await recordingRunner(SessionManager.inMemory(process.cwd()));
		await emitAll(runner);
		expect(seen).toEqual([...RUNTIME_EVENTS, ...LOOP_EVENTS]);
	});

	it("runs no loop handler through the specialized emitters on a runner with no session manager", async () => {
		// Given a runner without a session manager whose extension handles loop events.
		const seen: string[] = [];
		const extensions = await createTestExtensionsResult([
			(pi) => {
				pi.on("context", () => void seen.push("context"));
				pi.on("context_with_system", () => void seen.push("context_with_system"));
				pi.on("before_provider_request", () => void seen.push("before_provider_request"));
				pi.on("before_provider_headers", () => void seen.push("before_provider_headers"));
				pi.on("model_select", () => void seen.push("model_select"));
			},
		]);
		const runner = new ExtensionRunner(
			extensions.extensions,
			extensions.runtime,
			process.cwd(),
			undefined,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			extensions.eventBus,
		);
		const messages = [{ role: "user" as const, content: [], timestamp: 0 }];
		const payload = { probe: true };
		const headers = { "x-probe": "1" };
		// When each loop emitter runs.
		const context = await runner.emitContext(messages);
		const request = await runner.emitBeforeProviderRequest(payload);
		const sentHeaders = await runner.emitBeforeProviderHeaders(headers);
		// Then no handler ran, and every input passes through unchanged.
		expect(seen).toEqual([]);
		expect(context).toEqual(messages);
		expect(request).toBe(payload);
		expect(sentHeaders).toEqual(headers);
	});
});
