import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const COLUMN_GAP = 4;

function renderShortcutGrid(): string {
	const rows: readonly (readonly [string, string])[] = [
		[keyHint("app.interrupt", "interrupt"), keyHint("app.clear", "clear editor")],
		[keyHint("app.exit", "exit"), keyHint("app.approval.cycle", "approval mode")],
		[keyHint("app.model.cycleForward", "next model"), keyHint("app.model.select", "select model")],
		[keyHint("app.tools.expand", "expand tools"), keyHint("app.editor.external", "external editor")],
		[keyHint("app.message.followUp", "queue follow-up"), keyHint("app.history.search", "search history")],
		[rawKeyHint("!", "bash"), rawKeyHint("/", "commands")],
	];
	const leftColumnWidth = Math.max(...rows.map(([left]) => visibleWidth(left)));

	return rows
		.map(([left, right]) => `${left}${" ".repeat(leftColumnWidth - visibleWidth(left) + COLUMN_GAP)}${right}`)
		.join("\n");
}

export class ShortcutOverlay extends Container {
	constructor() {
		super();

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.fg("accent", theme.bold(" Keyboard shortcuts")), 0, 0));
		this.addChild(new Text(renderShortcutGrid(), 1, 0));
		this.addChild(new Text(theme.fg("dim", " /help for the full reference · any key to dismiss"), 0, 0));
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}

export function shouldShowShortcutOverlay(
	prevText: string,
	nextText: string,
	inputKind: "typed" | "paste" | "other",
): boolean {
	return prevText === "" && nextText === "?" && inputKind === "typed";
}

/**
 * Classify an editor change as paste or typed.
 *
 * The TUI editor exposes no per-change paste flag, so a clipboard paste is
 * signalled out-of-band by `pasteSignalled` (set on the paste entry point).
 * A multi-character jump is treated as a paste too, which catches bracketed
 * pastes that never reach the clipboard handler.
 */
export function classifyEditorInput(prevText: string, nextText: string, pasteSignalled: boolean): "typed" | "paste" {
	if (pasteSignalled) return "paste";
	return nextText.length - prevText.length > 1 ? "paste" : "typed";
}
