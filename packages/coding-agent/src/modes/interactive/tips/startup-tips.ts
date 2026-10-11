import type { Keybinding } from "../../../core/keybindings.ts";
import type { QuietStartup } from "../../../core/settings-manager.ts";
import { recordTipShown } from "./history-writer.ts";
import { resolveReasoningLevelNotice } from "./reasoning-level-notice.ts";
import { TIP_DEFINITIONS } from "./registry.ts";
import { resolveStartupTipLine } from "./startup-tip.ts";

export interface StartupTipsSettings {
	getTipsEnabled(): boolean;
	getQuietStartup(): QuietStartup;
	getTipsHistory(): Record<string, number>;
	setTipShown(tipId: string, timestamp: number): void;
}

export interface StartupTipsOptions {
	settings: StartupTipsSettings;
	now: number;
	modelReasoning: () => boolean;
	hasCommand: (command: string) => boolean;
	keys: (binding: Keybinding) => string;
	displayKeys: (binding: Keybinding) => string;
}

export interface StartupTips {
	text: string;
	tipIds: string[];
}

/**
 * The tip block under the startup header, recorded in the settings tip history
 * as it is resolved. The one-time reasoning-level notice (senpi#3090) goes
 * first; on the launch it shows, the rotating tip skips its own `thinking-level`
 * entry so the two do not repeat each other.
 */
export function resolveStartupTips(options: StartupTipsOptions): StartupTips | undefined {
	const { settings } = options;
	const tipsEnabled = settings.getTipsEnabled();
	// Header-only quiet startup keeps the header but not the startup details, tips included.
	const quietStartup = settings.getQuietStartup() !== false;
	const record = (tipId: string): void => {
		const next = recordTipShown(settings.getTipsHistory(), tipId, options.now);
		settings.setTipShown(tipId, next[tipId] ?? options.now);
	};
	const reasoningNotice =
		tipsEnabled && !quietStartup
			? resolveReasoningLevelNotice({
					history: settings.getTipsHistory(),
					modelReasoning: options.modelReasoning(),
					keys: options.displayKeys,
				})
			: undefined;
	if (reasoningNotice) record(reasoningNotice.tipId);
	const startupTip = resolveStartupTipLine({
		tipsEnabled,
		quietStartup,
		history: settings.getTipsHistory(),
		now: options.now,
		definitions: TIP_DEFINITIONS,
		keys: options.keys,
		hasCommand: options.hasCommand,
		...(reasoningNotice ? { exclude: new Set(["thinking-level"]) } : {}),
	});
	if (startupTip) record(startupTip.tipId);
	const shown = [reasoningNotice, startupTip].filter((tip) => tip !== undefined);
	if (shown.length === 0) return undefined;
	return { text: shown.map((tip) => tip.line).join("\n"), tipIds: shown.map((tip) => tip.tipId) };
}
