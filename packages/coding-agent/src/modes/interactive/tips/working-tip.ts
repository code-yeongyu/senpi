import type { Keybinding } from "../../../core/keybindings.ts";
import type { TipDefinition } from "./registry.ts";
import { selectTip } from "./scheduler.ts";

export interface WorkingTipOptions {
	tipsEnabled: boolean;
	history: Record<string, number>;
	sessionShownTipIds: ReadonlySet<string>;
	now: number;
	definitions: readonly TipDefinition[];
	keys: (binding: Keybinding) => string;
	hasCommand?: (command: string) => boolean;
}

export interface WorkingTipLine {
	line: string;
	tipId: string;
}

/**
 * Per-turn cache for the working-status tip.
 *
 * The tip is chosen once per turn and must survive the working indicator being
 * hidden and reshown mid-turn; `resetForNewTurn()` is called only at a real turn
 * boundary (agent_start).
 */
export class WorkingTipCache {
	private cached: { value: WorkingTipLine | undefined } | undefined;

	resetForNewTurn(): void {
		this.cached = undefined;
	}

	resolve(
		compute: () => WorkingTipLine | undefined,
		onFirstResolve?: (tip: WorkingTipLine) => void,
	): WorkingTipLine | undefined {
		if (this.cached !== undefined) return this.cached.value;
		const value = compute();
		this.cached = { value };
		if (value) onFirstResolve?.(value);
		return value;
	}
}

export function resolveWorkingTipLine(options: WorkingTipOptions): WorkingTipLine | undefined {
	if (!options.tipsEnabled) return undefined;

	const tip = selectTip(options.definitions, options.history, options.now, {
		keys: options.keys,
		...(options.hasCommand ? { hasCommand: options.hasCommand } : {}),
		exclude: options.sessionShownTipIds,
	});
	if (!tip) return undefined;

	const body = tip
		.render(options.keys)
		.replace(/\s*\n\s*/g, " ")
		.trim();
	const pointer = "↳ Want the full story on any tip? Ask about it: the give-me-tips skill has the tour.";
	return { line: `Tip: ${body}\n${pointer}`, tipId: tip.id };
}
