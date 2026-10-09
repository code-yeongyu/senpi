import { Box, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { NoticeSpec } from "./spec.ts";

const BOLD = "[1m";
const BOLD_OFF = "[22m";

function noticeText(text: string): Component {
	return {
		render(width: number): string[] {
			return wrapTextWithAnsi(text, Math.max(1, width));
		},
		invalidate(): void {},
	};
}

/** Render a NoticeSpec as the shared transcript notice box (loop-guard visual family). */
export function buildNoticeBox(spec: NoticeSpec, options: { readonly expanded: boolean }, theme: Theme): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(noticeText(theme.fg(spec.tone ?? "accent", `${BOLD}${spec.title}${BOLD_OFF}`)));
	box.addChild(noticeText(theme.fg("dim", spec.why)));
	for (const line of spec.extra ?? []) {
		box.addChild(noticeText(theme.fg(line.tone ?? "dim", line.text)));
	}
	if (options.expanded && spec.expandedLine !== undefined) {
		box.addChild(noticeText(theme.fg("dim", spec.expandedLine)));
	}
	return box;
}
