import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { EvalImageContent } from "../tool/image-resize.ts";

/** A notification's message content: plain text, or text and the cells' images in one message. */
export type EvalNotificationContent = string | ({ readonly type: "text"; readonly text: string } | EvalImageContent)[];

import type { EvalDetachedCellNotification, EvalDetachedCellNotifier } from "../tool/detached-cell-manager.ts";

const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

/** Provenance marker for agent-internal detached-cell notices. */
export const EVAL_NOTIFICATION_CUSTOM_TYPE = "senpi-codemode:notification";

export type EvalNotifyMode = "wake" | "next-turn" | "off";

export interface EvalNotifierDeps {
	/** Deliver a model-visible notification without rendering synthetic user input. */
	readonly sendMessage: (
		message: { customType: string; content: EvalNotificationContent; display: boolean },
		options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" },
	) => void;
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
		this.#deps.sendMessage(
			{
				customType: EVAL_NOTIFICATION_CUSTOM_TYPE,
				content: notificationContent(pending),
				display: false,
			},
			{ triggerTurn: true, deliverAs: mode === "wake" ? "steer" : "followUp" },
		);
	}
}

function notificationContent(cells: readonly EvalDetachedCellNotification[]): EvalNotificationContent {
	const text = cells.map((cell) => cell.content).join("\n\n");
	const images = cells.flatMap((cell) => cell.images ?? []);
	return images.length === 0 ? text : [{ type: "text", text }, ...images];
}
