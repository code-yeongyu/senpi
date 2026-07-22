import type { ReasoningEffort } from "./base.ts";

export type CollaborationModeKind = "plan" | "default";

export type CollaborationModeSettings = {
	readonly model: string;
	readonly reasoning_effort: ReasoningEffort | null;
	readonly developer_instructions: string | null;
};

export type CollaborationMode = {
	readonly mode: CollaborationModeKind;
	readonly settings: CollaborationModeSettings;
};

export type CollaborationModeMask = {
	readonly name: string;
	readonly mode: CollaborationModeKind | null;
	readonly model: string | null;
	readonly reasoning_effort: ReasoningEffort | null;
};

export type CollaborationModeListParams = Record<string, never>;
export type CollaborationModeListResponse = { readonly data: readonly CollaborationModeMask[] };

export const SENPI_COLLABORATION_MODE = {
	mode: "default",
	settings: {
		model: "unknown",
		reasoning_effort: "off",
		developer_instructions: null,
	},
} as const satisfies CollaborationMode;

export function buildSenpiCollaborationMode(model: string, reasoningEffort: ReasoningEffort | null): CollaborationMode {
	return {
		mode: SENPI_COLLABORATION_MODE.mode,
		settings: {
			model,
			reasoning_effort: reasoningEffort,
			developer_instructions: SENPI_COLLABORATION_MODE.settings.developer_instructions,
		},
	};
}

export function buildSenpiCollaborationModePreset(model: string): CollaborationModeMask {
	return {
		name: SENPI_COLLABORATION_MODE.mode,
		mode: null,
		model,
		reasoning_effort: null,
	};
}
