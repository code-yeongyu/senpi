import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatKeyText } from "../../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import type { Keybinding, KeybindingsManager } from "../../../keybindings.ts";
import { formatBtwQuestion, sanitizeBtwDisplayText } from "./display-text.ts";

export interface BtwSideLayout {
	readonly totalRows: number;
	readonly transcriptRows: number;
}

export function computeBtwSideLayout(input: { terminalRows: number; editorRows: number }): BtwSideLayout {
	const totalRows = Math.max(5, Math.floor(input.terminalRows));
	const transcriptRows = Math.max(0, totalRows - Math.max(1, input.editorRows) - 3);
	return { totalRows, transcriptRows };
}

export function fitBtwSideRow(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, "…") : text;
}

export function formatBtwSideFooter(keybindings: KeybindingsManager): string {
	const key = (binding: Keybinding): string => formatKeyText(keybindings.getKeys(binding)[0] ?? "");
	return formatBtwQuestion(
		`ctrl+/ switch · ${key("app.clear")} close · ${key("app.interrupt")} cancel · ${key("tui.editor.pageUp")}/${key("tui.editor.pageDown")} scroll`,
	);
}

export function renderBtwSideTurn(input: {
	readonly question: string;
	readonly answer: string;
	readonly width: number;
	readonly theme: Theme;
}): string[] {
	const questionRows = wrapTextWithAnsi(formatBtwQuestion(input.question), Math.max(1, input.width - 5)).map(
		(row, index) => fitBtwSideRow(`${index === 0 ? input.theme.fg("accent", "You:") : "    "} ${row}`, input.width),
	);
	const answerPrefix = input.theme.fg("success", "Side:");
	const answerRows = wrapTextWithAnsi(sanitizeBtwDisplayText(input.answer), Math.max(1, input.width - 6));
	if (answerRows.length === 0) return [...questionRows, fitBtwSideRow(answerPrefix, input.width)];
	return [
		...questionRows,
		...answerRows.map((row, index) => fitBtwSideRow(`${index === 0 ? answerPrefix : "     "} ${row}`, input.width)),
	];
}
