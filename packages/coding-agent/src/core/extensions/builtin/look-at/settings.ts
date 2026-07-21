import type { ExtensionContext } from "../../types.ts";
import { DEFAULT_LOOK_AT_CHAIN } from "./model-selector.ts";

export interface LookAtStore {
	getOverride(): { models?: string[]; enabled?: boolean };
	setModels(models: string[] | undefined): void;
	setEnabled(enabled: boolean | undefined): void;
}

export function createLookAtStore(): LookAtStore {
	let override: { models?: string[]; enabled?: boolean } = {};

	return {
		getOverride: () => override,
		setModels: (models) => {
			override = { ...override, models };
		},
		setEnabled: (enabled) => {
			override = { ...override, enabled };
		},
	};
}

export function loadLookAtChain(ctx: Pick<ExtensionContext, "getLookAtSettings">, store: LookAtStore): string[] {
	return store.getOverride().models ?? ctx.getLookAtSettings().models ?? [...DEFAULT_LOOK_AT_CHAIN];
}

export function loadLookAtEnabled(ctx: Pick<ExtensionContext, "getLookAtSettings">, store: LookAtStore): boolean {
	return store.getOverride().enabled ?? ctx.getLookAtSettings().enabled;
}
