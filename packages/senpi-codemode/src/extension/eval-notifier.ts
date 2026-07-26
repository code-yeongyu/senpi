import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { EvalDetachedCellNotification, EvalDetachedCellNotifier } from "../tool/detached-cell-manager.ts";

const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

export type EvalNotifyMode = "wake" | "next-turn" | "off";

export interface EvalNotifierDeps {
	readonly sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
	readonly getContext: () => ExtensionContext | undefined;
	readonly getMode: () => EvalNotifyMode;
}

/** Session-scoped completion injector with the same no-spin guards as terminal notifications. */
export class EvalNotifier implements EvalDetachedCellNotifier {
	readonly #deps: EvalNotifierDeps;
	readonly #notified = new Set<string>();

	constructor(deps: EvalNotifierDeps) {
		this.#deps = deps;
	}

	/** Starts a fresh session generation without suppressing reused tool-call ids. */
	reset(): void {
		this.#notified.clear();
	}

	notify(cells: readonly EvalDetachedCellNotification[]): void {
		const mode = this.#deps.getMode();
		if (mode === "off") return;
		const ctx = this.#deps.getContext();
		if (ctx === undefined || NON_INTERACTIVE_MODES.has(ctx.mode) || ctx.model === undefined) return;
		const pending = cells.filter((cell) => !this.#notified.has(cell.cellId));
		if (pending.length === 0) return;
		for (const cell of pending) this.#notified.add(cell.cellId);
		this.#deps.sendUserMessage(pending.map((cell) => cell.content).join("\n\n"), {
			deliverAs: mode === "wake" ? "steer" : "followUp",
		});
	}
}
