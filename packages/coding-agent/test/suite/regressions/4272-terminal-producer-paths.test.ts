import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier, setSessionRecoveryEpoch } from "../../../src/core/session-recovery-identity.ts";
import { SessionAcceptanceLane, type FrozenAcceptedRoot } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { createBoundLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

afterEach(() => vi.unstubAllEnvs());

// Part of #4272: the two producer append paths that differ from ordinary user/assistant persistence.
it("C2.1 T1 toolResult freezes the full result before its owned durable append", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const tool: AgentTool = {
		name: "result",
		label: "Result",
		description: "Return a deterministic result",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "full tool output" }], details: { complete: true } }),
	};
	const h = await createBoundLifecycleHarness({ tools: [tool], persistSession: true });
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: h.sessionManager.beginTranscriptJournal() });
	setSessionRecoveryEpoch?.(h.session, lane.recoveryEpoch);
	let cut: FrozenAcceptedRoot | undefined;
	let messageId: string | undefined;
	const stop = h.session.subscribe((event) => {
		lane.applyTranscript(h.sessionManager.drainTranscript());
		lane.accept(event, recoveryCarrier(event));
		if (event.type === "message_end" && event.message.role === "toolResult") {
			cut = lane.freeze();
			messageId = recoveryCarrier(event)?.messageId;
		}
	});
	try {
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("result", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("use the tool");
		expect(cut?.settled).toBeDefined();
		if (!cut) throw new Error("no tool result cut");
		expect((await lane.readSettled(cut)).settledMessages.find((row) => row.messageId === messageId)).toMatchObject({
			role: "toolResult",
			status: "pending",
			entryId: null,
			terminal: { content: [{ type: "text", text: "full tool output" }], details: { complete: true } },
		});
		const final = await lane.readSettled(lane.freeze());
		expect(final.settledMessages).toEqual([]);
		expect(final.owners.find((row) => row.messageId === messageId)?.entryId).toBeTypeOf("string");
	} finally {
		stop();
		lane.retire("close");
		await lane.idle?.();
		h.cleanup();
	}
}, 60000);

it("C2.2 Q3 lifecycle consume binds the entry before its custom terminal and carries a committed hint", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const h = await createBoundLifecycleHarness({ persistSession: true });
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: h.sessionManager.beginTranscriptJournal() });
	setSessionRecoveryEpoch?.(h.session, lane.recoveryEpoch);
	const cuts: { root: FrozenAcceptedRoot; id: string; hint?: string }[] = [];
	const stop = h.session.subscribe((event) => {
		lane.applyTranscript(h.sessionManager.drainTranscript());
		lane.accept(event, recoveryCarrier(event));
		if (
			event.type === "message_end" &&
			event.message.role === "custom" &&
			event.message.customType === "senpi-task.completion"
		) {
			const carrier = recoveryCarrier(event);
			if (!carrier) throw new Error("no custom owner");
			cuts.push({ root: lane.freeze(), id: carrier.messageId, hint: carrier.durableEntryId });
		}
	});
	try {
		const ticket = h.session.workObligations
			.open("task:review", "children")
			.transfer("omo-wake-queue:review")
			.ticket();
		h.setResponses([fauxAssistantMessage("incorporated")]);
		await runToAgentIdle(h, () =>
			h.session.sendCustomMessage(
				{ customType: "senpi-task.completion", content: "review result", display: false },
				{ triggerTurn: true, ticket },
			),
		);
		expect(cuts).toHaveLength(1);
		const cut = cuts[0];
		expect(cut.root.settled).toBeDefined();
		expect(cut.hint).toBeTypeOf("string");
		const state = await lane.readSettled(cut.root);
		expect(state.settledMessages.some((row) => row.messageId === cut.id)).toBe(false);
		expect(state.owners.find((row) => row.messageId === cut.id)?.entryId).toBe(cut.hint);
	} finally {
		stop();
		lane.retire("close");
		await lane.idle?.();
		h.cleanup();
	}
}, 60000);
