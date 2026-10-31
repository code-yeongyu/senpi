import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeResult } from "../../../src/core/agent-session-runtime.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createHarness } from "../harness.ts";
import { makeSink } from "../rpc-connection-harness.ts";
import { createStructuredHarness, type StructuredHarness } from "../structured-lane-sdk-harness.ts";
import { scriptProvider, textReply } from "../structured-lane-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

async function session(lane: boolean): Promise<StructuredHarness> {
	if (lane) {
		const harness = await createStructuredHarness();
		scriptProvider(harness, [textReply("ok")]);
		return harness;
	}
	// createHarness builds its Agent outside the session layer: the embedder shape with no structured lane.
	const harness = await createHarness();
	harness.setResponses([fauxAssistantMessage("ok")]);
	return harness;
}

// Part of #4272 (option B): with the rollout flag off, a session without a structured lane opens and binds legacy-only,
// as before S17; a session with the lane keeps internal capture and acceptance.
it.each([
	{ lane: false, name: "binds legacy-only without the structured lane" },
	{ lane: true, name: "keeps internal capture and acceptance with the structured lane" },
])("flag off: an RPC open $name", async ({ lane }) => {
	vi.stubEnv(FLAG, "0");
	const harness = await session(lane);
	cleanups.push(() => harness.cleanup());
	expect(harness.session.hasStructuredLane).toBe(lane);
	const registry = new RpcSessionRegistry({
		agentDir: harness.session.agentDir,
		createRuntime: async ({ cwd, agentDir }) =>
			({
				session: harness.session,
				diagnostics: [],
				services: { cwd, agentDir },
			}) as unknown as CreateAgentSessionRuntimeResult,
	});
	const socket = makeSink();
	const writer = new SessionEventWriter(socket.sink.writeRaw, (flush) => flush());
	const router = new SessionCommandRouter(registry, writer, { cwd: harness.tempDir });
	cleanups.push(() => router.dispose());

	const opened = socket.waitFor((record) => record.type === "response" && record.id === "open");
	await router.handle({ id: "open", type: "open_session", cwd: harness.tempDir });
	await writer.flush();
	const response = await opened;
	expect(response).toMatchObject({ success: true });
	const sessionId = String(response.sessionId);
	expect(registry.peek(sessionId)?.acceptance !== undefined).toBe(lane);

	const structured: object[] = [];
	cleanups.push(writer.structuredLanes.observe(sessionId, (record) => structured.push(record)));
	const ended = socket.waitFor((record) => record.type === "agent_end" && record.sessionId === sessionId, 5_000);
	await router.handle({ id: "go", type: "prompt", sessionId, message: "hi" });
	await ended;
	await writer.flush();

	// Then: legacy delivery is identical either way; only a session with the lane produced structured records.
	expect(socket.messages()).toContainEqual(
		expect.objectContaining({
			type: "message_end",
			sessionId,
			message: expect.objectContaining({ role: "assistant" }),
		}),
	);
	expect(structured.length > 0).toBe(lane);
});
