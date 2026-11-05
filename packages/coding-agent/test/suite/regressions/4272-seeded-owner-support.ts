import {
	type AssistantMessageEvent,
	type AssistantProgress,
	carryAssistantCapture,
	subscribeAssistantCapture,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "../../../../ai/src/utils/event-stream.ts";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import type { SeededBlockEvent } from "../../../src/modes/rpc/compact-seeded-block.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { spoolRoot, startIdentity } from "../compact-storage-support.ts";
import { assistant, update } from "./4272-seeded-json-fixtures.ts";

export async function seededOwner() {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir, spillAboveBytes: 0, spillTargetBytes: 0 });
	const release = subscribeAssistantCapture();
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const partial = assistant();
	const first = startIdentity();
	let identity = first;
	const accept = (event: SeededBlockEvent) => {
		const result = state.accept({
			type: "seeded_block",
			...identity,
			messageId: "message",
			event,
		});
		identity = startIdentity(first.firstOrdinal);
		return result;
	};
	const pushed = new WeakSet<AssistantMessageEvent>();
	const pushOnce = (event: AssistantMessageEvent, hint?: Parameters<typeof stream.push>[1]) => {
		if (pushed.has(event)) return;
		pushed.add(event);
		stream.push(event, hint);
	};
	const projectUpdate = (event: AssistantMessageEvent, hint?: Parameters<typeof stream.push>[1]) => {
		pushOnce(event, hint);
		const record = toJsonEvent(update(event), { blockSeeds: 1 });
		if (record?.type !== "message_update") throw new Error("missing producer capture");
		return record;
	};
	const project = (event: AssistantMessageEvent, hint?: Parameters<typeof stream.push>[1]) => {
		const record = projectUpdate(event, hint);
		if (!("contentIndex" in record.assistantMessageEvent)) throw new Error("missing indexed producer capture");
		return record.assistantMessageEvent;
	};
	// Message-level records use the same projector; an outer start or end carries its pushed event's capture.
	const record = (event: AssistantMessageEvent, outer?: "message_start" | "message_end") => {
		if (!outer) {
			const seeded = projectUpdate(event);
			const nested = seeded.assistantMessageEvent;
			if ("contentIndex" in nested) throw new Error("indexed records use seeded_block");
			return { ...seeded, assistantMessageEvent: nested };
		}
		pushOnce(event);
		const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
		const session: AgentSessionEvent = { type: outer, message: { ...message } };
		const seeded = toJsonEvent(carryAssistantCapture(event, session, outer === "message_end" ? message : undefined), {
			blockSeeds: 1,
		});
		if (seeded?.type !== "message_start" && seeded?.type !== "message_end") throw new Error("missing outer record");
		return seeded;
	};
	const message = (
		event: AssistantMessageEvent,
		outer?: "message_start" | "message_end",
		extra: {
			readonly invalidatedBlocks?: readonly number[];
			readonly rewrittenFrom?: number;
			readonly correlation?: object;
		} = {},
	) => {
		const result = state.accept({
			type: "seeded_message",
			...identity,
			messageId: "message",
			record: record(event, outer),
			...extra,
		});
		identity = startIdentity(first.firstOrdinal);
		return result;
	};
	return {
		state,
		partial,
		accept,
		// Deliberately bypass the type boundary only for malformed-input rejection cases.
		malformed(event: object) {
			return Reflect.apply(state.accept, state, [
				{ type: "seeded_block", ...identity, messageId: "message", event },
			]);
		},
		project,
		record,
		message,
		push(event: AssistantMessageEvent, hint?: Parameters<typeof stream.push>[1]) {
			return accept(project(event, hint));
		},
		/** An indexed update together with the usage and changed message metadata its record carries. */
		pushUpdate(event: AssistantMessageEvent, hint?: Parameters<typeof stream.push>[1]) {
			const record = projectUpdate(event, hint);
			if (!("contentIndex" in record.assistantMessageEvent)) throw new Error("missing indexed producer capture");
			const result = state.accept({
				type: "seeded_block",
				...identity,
				messageId: "message",
				event: record.assistantMessageEvent,
				usage: record.usage,
				...(record.messageMetadata ? { messageMetadata: record.messageMetadata } : {}),
			});
			identity = startIdentity(first.firstOrdinal);
			return result;
		},
		control(event: AssistantProgress) {
			return accept(event);
		},
		async view() {
			const cut = state.freeze();
			try {
				return await state.read(cut);
			} finally {
				state.release(cut);
			}
		},
		async [Symbol.asyncDispose]() {
			release();
			stream.end(partial);
			await state.retire();
			await root.cleanup();
		},
	};
}
