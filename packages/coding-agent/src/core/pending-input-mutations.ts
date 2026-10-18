import type {
	PendingInput,
	PendingInputDecision,
	PendingInputEvent,
	PendingInputHandle,
	PendingInputOperationResult,
} from "./pending-input-types.ts";

type MutationEvent = Extract<PendingInputEvent, { readonly type: "edit" | "remove" | "retry" }>;

export function reduceMutation(current: PendingInput | undefined, event: MutationEvent): PendingInputDecision {
	if (current === undefined) return refuse(undefined, { outcome: "not_found", clientMessageId: "" });
	const fingerprint = mutationFingerprint(event);
	const recorded = current.operations[event.effectId];
	if (recorded !== undefined) {
		if (recorded.fingerprint !== fingerprint) return refuse(current, answer(current, "effect_id_conflict"));
		return refuse(current, { ...recorded.result, replayed: true });
	}
	const refusal = mutationRefusal(current, event);
	if (refusal !== undefined) {
		const next: PendingInput = {
			...current,
			operations: { ...current.operations, [event.effectId]: { fingerprint, result: refusal } },
		};
		return { next, result: refusal, effects: [{ type: "persist" }] };
	}
	const applied = applyMutation(current, event);
	const next: PendingInput = {
		...applied.next,
		operations: { ...current.operations, [event.effectId]: { fingerprint, result: applied.result } },
	};
	return { next, result: applied.result, effects: [{ type: "persist" }] };
}

function mutationRefusal(current: PendingInput, event: MutationEvent): PendingInputOperationResult | undefined {
	if (current.phase === "delivered") return answer(current, "already_delivered");
	if (current.phase === "removed") return answer(current, "not_found");
	if (!sameHandle(current.handle, event.handle)) return answer(current, "stale_handle");
	if (current.phase === "sending") return answer(current, event.type === "retry" ? "not_retryable" : "sending");
	if (event.type === "retry") {
		return current.phase === "failed" && current.failure?.delivery === "not_delivered"
			? undefined
			: answer(current, "not_retryable");
	}
	if (current.phase === "failed") {
		if (current.failure?.delivery === "uncertain") return answer(current, "unresolved");
		if (event.type === "edit") return answer(current, "not_editable");
	}
	if (event.expectedRevision !== current.revision) {
		return { ...answer(current, "conflict"), currentRevision: current.revision };
	}
	return undefined;
}

function applyMutation(
	current: PendingInput,
	event: MutationEvent,
): { readonly next: PendingInput; readonly result: PendingInputOperationResult } {
	switch (event.type) {
		case "edit": {
			const revision = current.revision + 1;
			const next: PendingInput = {
				...current,
				revision,
				hasEdits: true,
				text: event.text,
				attachments: event.attachments,
				superseded: [
					...current.superseded,
					{ lifetimeId: current.handle.lifetimeId, revision: current.revision, text: current.text },
				],
			};
			return { next, result: { ...answer(next, "edited"), revision, text: event.text } };
		}
		case "remove": {
			const next = withoutFailure({ ...current, phase: "removed", removedBy: "remove" });
			return { next, result: answer(next, "removed") };
		}
		case "retry": {
			const next = withoutFailure({ ...current, phase: "queued" });
			return { next, result: { ...answer(next, "requeued"), revision: next.revision } };
		}
	}
}

function withoutFailure(input: PendingInput): PendingInput {
	const { failure: _failure, ...rest } = input;
	return rest;
}

function mutationFingerprint(event: MutationEvent): string {
	const target = `${event.handle.lifetimeId}/${event.handle.queuedId}`;
	switch (event.type) {
		case "edit":
			return JSON.stringify(["edit", target, event.expectedRevision, event.text, event.attachments]);
		case "remove":
			return JSON.stringify(["remove", target, event.expectedRevision]);
		case "retry":
			return JSON.stringify(["retry", target]);
	}
}

function sameHandle(a: PendingInputHandle, b: PendingInputHandle): boolean {
	return a.lifetimeId === b.lifetimeId && a.queuedId === b.queuedId;
}

export function answer(
	input: PendingInput,
	outcome: PendingInputOperationResult["outcome"],
): PendingInputOperationResult {
	return {
		outcome,
		clientMessageId: input.clientMessageId,
		revision: input.revision,
		lifetimeId: input.handle.lifetimeId,
	};
}

function refuse(current: PendingInput | undefined, result: PendingInputOperationResult): PendingInputDecision {
	return { next: current, result, effects: [] };
}
