import type { Keybinding } from "../../../core/keybindings.ts";
import type { StartupTipLine } from "./startup-tip.ts";

/**
 * Id under which the one-time notice is recorded in the settings tip history
 * (`tipsHistory`), the same store the rotating startup tips use. Once it has a
 * timestamp there it is never shown again from that agent directory.
 */
export const REASONING_LEVEL_TIP_ID = "reasoning-level-key";

export interface ReasoningLevelNoticeOptions {
	history: Record<string, number>;
	modelReasoning: boolean;
	keys: (binding: Keybinding) => string;
}

/**
 * The one-time "<key> changes the reasoning level" notice for a reasoning model.
 * Shown only once per agent directory (tracked in the tip history) and only when
 * `app.thinking.cycle` is actually bound, so the key named is the user's own.
 */
export function resolveReasoningLevelNotice(options: ReasoningLevelNoticeOptions): StartupTipLine | undefined {
	if (!options.modelReasoning) return undefined;
	if (Object.hasOwn(options.history, REASONING_LEVEL_TIP_ID)) return undefined;
	const key = options.keys("app.thinking.cycle");
	if (!key) return undefined;
	return { tipId: REASONING_LEVEL_TIP_ID, line: `Tip: ${key} changes the reasoning level` };
}
