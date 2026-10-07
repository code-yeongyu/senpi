/**
 * Who or what changed a session's model (senpi#2870). Recorded on every `model_change` entry, on the
 * `thinking_level_change` a switch writes, on the `model_changed` event and in the session log, so a
 * switch nobody remembers making can be attributed from the session record alone.
 */
export type ModelChangeSource =
	/** A typed `/model <id>` in the terminal UI. */
	| "command"
	/** Enter in the model picker or the favorites picker. */
	| "picker"
	/** The favorites cycle key. */
	| "cycle"
	/** A terminal session's control endpoint `set_model`. */
	| "control"
	/** An RPC client's `set_model`, `cycle_model` or `set_fast_mode`. */
	| "rpc"
	/** An app-server thread setting. */
	| "app-server"
	/** An extension's `setModel` / `setSessionModel`; `actor` is the extension path. */
	| "extension"
	/** The default model chosen after a provider login. */
	| "provider-login"
	/** The retry controller moving to a fallback model, or back. */
	| "fallback"
	| "fallback-revert"
	/** A switch held until compaction made room, applied on the next send; `actor` names its first source. */
	| "held-switch"
	/** A restored virtual-model selection re-recorded on resume. */
	| "restore"
	/** An SDK caller that named no source. */
	| "sdk";

export interface ModelChangeOrigin {
	readonly source: ModelChangeSource;
	/** Who issued it, where known: an extension path, an RPC client, the picker that was used. */
	readonly actor?: string;
}

export const SDK_MODEL_CHANGE: ModelChangeOrigin = { source: "sdk" };

export function heldSwitchOrigin(first: ModelChangeOrigin): ModelChangeOrigin {
	return { source: "held-switch", actor: first.actor === undefined ? first.source : `${first.source}:${first.actor}` };
}

export function modelChangeLogFields(input: {
	readonly origin: ModelChangeOrigin;
	readonly from: { readonly provider: string; readonly id: string } | undefined;
	readonly to: { readonly provider: string; readonly id: string };
	readonly duringTurn: boolean;
	readonly persistDefault: boolean;
}): Record<string, string | boolean> {
	return {
		source: input.origin.source,
		...(input.origin.actor === undefined ? {} : { actor: input.origin.actor }),
		...(input.from === undefined ? {} : { from: `${input.from.provider}/${input.from.id}` }),
		to: `${input.to.provider}/${input.to.id}`,
		duringTurn: input.duringTurn,
		persistDefault: input.persistDefault,
	};
}
