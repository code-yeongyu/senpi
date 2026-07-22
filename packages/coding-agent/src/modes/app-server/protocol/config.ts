import type { AskForApproval, JsonValue, ReasoningEffort, SandboxMode } from "./base.ts";

export type Config = {
	readonly model: string | null;
	readonly model_provider: string | null;
	readonly approval_policy: AskForApproval | null;
	readonly sandbox_mode: SandboxMode | null;
	readonly model_reasoning_effort: ReasoningEffort | null;
};

export type ConfigLayerSource =
	| { readonly type: "mdm"; readonly domain: string; readonly key: string }
	| { readonly type: "system"; readonly file: string }
	| { readonly type: "enterpriseManaged"; readonly id: string; readonly name: string }
	| { readonly type: "user"; readonly file: string; readonly profile: string | null }
	| { readonly type: "project"; readonly dotCodexFolder: string }
	| { readonly type: "sessionFlags" }
	| { readonly type: "legacyManagedConfigTomlFromFile"; readonly file: string }
	| { readonly type: "legacyManagedConfigTomlFromMdm" };

export type ConfigLayerMetadata = {
	readonly name: ConfigLayerSource;
	readonly version: string;
};

export type ConfigLayer = {
	readonly name: ConfigLayerSource;
	readonly version: string;
	readonly config: JsonValue;
	readonly disabledReason: string | null;
};

export type ConfigReadParams = {
	readonly includeLayers?: boolean;
	readonly cwd?: string | null;
};
export type ConfigReadResponse = {
	readonly config: Config;
	readonly origins: Readonly<Record<string, ConfigLayerMetadata | undefined>>;
	readonly layers: readonly ConfigLayer[] | null;
};

export type ConfigRequirementsReadParams = undefined;
export type ConfigRequirementsReadResponse = { readonly requirements: null };
