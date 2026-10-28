import { type AssistantMessageEvent, type AssistantProgress, subscribeAssistantCapture } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "../../../../ai/src/utils/event-stream.ts";
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
	const project = (event: AssistantMessageEvent, hint?: Parameters<typeof stream.push>[1]) => {
		stream.push(event, hint);
		const record = toJsonEvent(update(event), { blockSeeds: 1 });
		if (record?.type !== "message_update" || !("contentIndex" in record.assistantMessageEvent))
			throw new Error("missing indexed producer capture");
		return record.assistantMessageEvent;
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
		push(event: AssistantMessageEvent, hint?: Parameters<typeof stream.push>[1]) {
			return accept(project(event, hint));
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
