import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { RecoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import type { CanonicalUnit } from "../../../src/modes/rpc/compact-lane-transitions.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { settledRig } from "./4272-settled-support.ts";

type AssistantEvent = Extract<CanonicalUnit["record"], { type: "message_update" }>["assistantMessageEvent"];
type Accepted = ReturnType<SessionAcceptanceLane["accept"]>;
const usage = fauxAssistantMessage("", { timestamp: 1 }).usage;
const CORRELATED = { clientMessageId: "c1" } as const;

/** Drives the real acceptance lane with hand-built canonical units the way the structured lane projects them. */
export async function callsRig() {
	const rig = await settledRig();
	let ordinal = 0;
	const open = new Map<string, { readonly carrier: RecoveryCarrier; readonly firstOrdinal: number }>();
	const unit = (carrier: RecoveryCarrier, record: CanonicalUnit["record"], first?: number): CanonicalUnit => {
		const own = ++ordinal;
		return { record, carrier, ordinal: own, firstOrdinal: first ?? own };
	};
	const update = (
		carrier: RecoveryCarrier,
		assistantMessageEvent: AssistantEvent,
		resolvedToolName?: string,
	): Accepted => {
		const live = open.get(carrier.messageId);
		if (!live) throw new Error("no open assistant message");
		const legacy = { type: "message_update", clientMessageId: "c1", clientTurnId: "t1" };
		const record = Object.assign(
			{
				type: "message_update" as const,
				usage,
				assistantMessageEvent,
				...(resolvedToolName === undefined ? {} : { resolvedToolName }),
			},
			CORRELATED,
		);
		return rig.lane.accept(legacy, carrier, unit(carrier, record, live.firstOrdinal));
	};
	return {
		...rig,
		/** The outer start of one assistant stream; later block records join by this carrier. */
		start(content: AssistantMessage["content"] = []): RecoveryCarrier {
			const message = { ...fauxAssistantMessage(content, { timestamp: 1 }) };
			const record = { type: "message_start", message, clientMessageId: "c1", clientTurnId: "t1" };
			rig.producer.observe(record);
			const carrier = recoveryCarrier(record);
			if (!carrier) throw new Error("producer failed to mint");
			const own = ordinal + 1;
			open.set(carrier.messageId, { carrier, firstOrdinal: own });
			const seeded = Object.assign({ type: "message_start" as const, message }, CORRELATED);
			rig.lane.accept(record, carrier, unit(carrier, seeded));
			return carrier;
		},
		toolStart(carrier: RecoveryCarrier, contentIndex: number, call: ToolCall, resolvedToolName?: string): Accepted {
			return update(
				carrier,
				{
					type: "toolcall_start",
					contentIndex,
					id: call.id,
					toolName: call.name,
					seed: {
						block: { ...call, arguments: {} },
						rawArgumentPrefix: "",
						parsedThrough: 0,
						coveredCodeUnits: 0,
						nextOffset: 0,
					},
				},
				resolvedToolName,
			);
		},
		toolDelta(carrier: RecoveryCarrier, contentIndex: number, offset: number, delta: string): void {
			update(carrier, { type: "toolcall_delta", contentIndex, delta, offset, parsedThrough: 0 });
		},
		toolEnd(carrier: RecoveryCarrier, contentIndex: number, toolCall: ToolCall, resolvedToolName?: string): void {
			update(carrier, { type: "toolcall_end", contentIndex, toolCall }, resolvedToolName);
		},
		blockName(carrier: RecoveryCarrier, contentIndex: number, name: string): void {
			const live = open.get(carrier.messageId);
			if (!live) throw new Error("no open assistant message");
			rig.lane.acceptControl(
				unit(carrier, { type: "message_block_metadata", contentIndex, name }, live.firstOrdinal),
			);
		},
		/** The authoritative terminal of the open stream. */
		end(carrier: RecoveryCarrier, content: AssistantMessage["content"], stopReason?: "error"): void {
			const live = open.get(carrier.messageId);
			if (!live) throw new Error("no open assistant message");
			const message = fauxAssistantMessage(content, {
				timestamp: 1,
				...(stopReason ? { stopReason, errorMessage: "boom" } : {}),
			});
			const record = { type: "message_end", message };
			rig.lane.accept(record, carrier, unit(carrier, { type: "message_end", message }, live.firstOrdinal));
			open.delete(carrier.messageId);
		},
		/** A record with no canonical half: tool execution, hooks, turn and run boundaries. */
		record(record: object): Accepted {
			return rig.lane.accept(record, undefined);
		},
		toolResult(toolCallId: string, toolName: string, text: string, isError = false): RecoveryCarrier {
			const message = {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError,
				timestamp: 1,
			};
			const record = { type: "message_end", message };
			rig.producer.observe(record);
			const carrier = recoveryCarrier(record);
			if (!carrier) throw new Error("producer failed to mint");
			rig.lane.accept(record, carrier);
			return carrier;
		},
		async calls(root: FrozenAcceptedRoot = rig.lane.freeze()) {
			return { root, ...(await rig.lane.readCurrentCalls(root)) };
		},
	};
}

export type CallsRig = Awaited<ReturnType<typeof callsRig>>;

/** Announces one complete call `id` in its own assistant message, the way a model turn does before execution. */
export async function announced(
	rig: CallsRig,
	id: string,
	name = "bash",
): Promise<{ owner: ReturnType<CallsRig["start"]>; call: ToolCall; started: Accepted }> {
	const owner = rig.start();
	const call = fauxToolCall(name, { command: id }, { id });
	const started = rig.toolStart(owner, 0, call, name);
	rig.toolEnd(owner, 0, call, name);
	rig.end(owner, [call]);
	return { owner, call, started };
}
