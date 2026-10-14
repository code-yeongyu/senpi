import type { EffectOutcome } from "./effect-record.ts";

/**
 * The user-facing copy of every effect outcome that is not a plain success: the code, what happened in
 * plain words, and what the caller can do. One table so a client renders the same words the host wrote.
 */
export const EFFECT_OUTCOMES = {
	inputInterruptedByReopen: {
		kind: "interrupted_by_reopen",
		reason: "interrupted_by_reopen",
		detail: "the session was reopened while this input's turn was running, so that turn never finished",
		action: "read the transcript for what the turn produced, then send the input again with a new clientMessageId",
	},
	inputDroppedByReplace: {
		kind: "dropped_by_replace",
		reason: "dropped_by_replace",
		detail: "the session was replaced (new_session, switch_session or fork) before this queued input was delivered",
		action: "send the input again with a new clientMessageId on the current session",
	},
	abortInterruptedByReopen: {
		kind: "interrupted_by_reopen",
		reason: "interrupted_by_reopen",
		detail: "the session was reopened, so the turn this abort targeted is no longer running",
	},
	setModelInterruptedByReopen: {
		kind: "interrupted_by_reopen",
		reason: "interrupted_by_reopen",
		detail: "the host restarted before the model switch was applied",
		action: "send set_model again with a new effectId",
	},
	setModelSuperseded: {
		kind: "superseded",
		reason: "superseded",
		detail: "a newer model selection replaced this switch before it was applied",
		action: "read the current model, then send set_model with a new effectId if you still want this model",
	},
	setModelDroppedByReplace: {
		kind: "dropped_by_replace",
		reason: "dropped_by_replace",
		detail: "the session was replaced (new_session, switch_session or fork) before this model switch was applied",
		action: "read the current model, then send set_model with a new effectId on the current session",
	},
	setThinkingInterruptedByReopen: {
		kind: "interrupted_by_reopen",
		reason: "interrupted_by_reopen",
		detail: "the host restarted before the thinking level was applied",
		action: "send set_thinking_level again with a new effectId",
	},
	dequeueInterruptedByReopen: {
		kind: "interrupted_by_reopen",
		reason: "interrupted_by_reopen",
		detail: "the session was reopened before the queued input was removed",
		action: "re-read queue_update.queued and retry with a new effectId",
	},
} as const satisfies Record<string, EffectOutcome>;

export function unknownModelOutcome(provider: string, modelId: string): EffectOutcome {
	return {
		kind: "unknown_model",
		reason: "unknown_model",
		detail: `no available model is named ${provider}/${modelId}`,
		action: "pick a model from get_available_models and send set_model again with a new effectId",
	};
}

export function providerUnavailableOutcome(detail: string): EffectOutcome {
	return {
		kind: "provider_unavailable",
		reason: "provider_unavailable",
		detail,
		action: "sign in to the provider or pick another model, then send set_model again with a new effectId",
	};
}

export function contextBudgetOutcome(detail: string): EffectOutcome {
	return {
		kind: "context_budget",
		reason: "context_budget",
		detail,
		action:
			"compact the session or pick a model with a larger context window, then send set_model with a new effectId",
	};
}

export function modelSwitchErrorOutcome(detail: string): EffectOutcome {
	return {
		kind: "error",
		reason: "error",
		detail,
		action: "read the error, then send set_model again with a new effectId after correcting its cause",
	};
}

export function unsupportedThinkingLevelOutcome(detail: string): EffectOutcome {
	return {
		kind: "unsupported_thinking_level",
		reason: "unsupported_thinking_level",
		detail,
		action: "pick a level from get_available_thinking_levels and send it again with a new effectId",
	};
}

export function turnErrorOutcome(detail: string | undefined): EffectOutcome {
	return {
		kind: "error",
		reason: "error",
		detail: detail ?? "the turn ended with a provider error",
		action: "read the error in the transcript, then retry the turn",
	};
}
