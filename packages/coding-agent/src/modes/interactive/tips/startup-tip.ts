import type { Keybinding } from "../../../core/keybindings.ts";
import type { TipDefinition } from "./registry.ts";
import { selectTip } from "./scheduler.ts";

export interface StartupTipOptions {
	tipsEnabled: boolean;
	quietStartup: boolean;
	history: Record<string, number>;
	now: number;
	definitions: readonly TipDefinition[];
	keys: (binding: Keybinding) => string;
	hasCommand?: (command: string) => boolean;
	exclude?: ReadonlySet<string>;
}

export interface StartupTipLine {
	line: string;
	tipId: string;
}

export function resolveStartupTipLine(options: StartupTipOptions): StartupTipLine | undefined {
	if (!options.tipsEnabled) return undefined;
	if (options.quietStartup) return undefined;

	const selectOptions = {
		keys: options.keys,
		...(options.hasCommand ? { hasCommand: options.hasCommand } : {}),
		...(options.exclude ? { exclude: options.exclude } : {}),
	};
	const tip = selectTip(options.definitions, options.history, options.now, selectOptions);
	if (!tip) return undefined;

	const body = tip
		.render(options.keys)
		.replace(/\s*\n\s*/g, " ")
		.trim();
	const pointer = "↳ Want the full story on any tip? Ask about it: the give-me-tips skill has the tour.";
	return { line: `Tip: ${body}\n${pointer}`, tipId: tip.id };
}
