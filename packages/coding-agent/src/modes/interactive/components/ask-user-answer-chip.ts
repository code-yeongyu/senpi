import { type Component, Container, MouseRegion, truncateToWidth } from "@earendil-works/pi-tui";
import { ASK_USER_QUESTION_ENTRY } from "../../../core/extensions/builtin/ask-user/notify.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";

export interface AskUserAnswerFrame {
	readonly requestId: string;
	readonly body: string;
}

export function parseAskUserAnswerFrame(text: string): AskUserAnswerFrame | undefined {
	const match = /^\[Answer to question ([^\]\r\n]+)\]\r?\n([\s\S]*)$/.exec(text);
	return match ? { requestId: match[1], body: match[2] } : undefined;
}

/** Custom entries are display metadata, excluded from model context. Older sessions may lack them. */
export function getAskUserAnswerHeaders(entries: readonly SessionEntry[], requestId: string): readonly string[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== ASK_USER_QUESTION_ENTRY) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null || !("requestId" in data) || data.requestId !== requestId) continue;
		if (!("headers" in data) || !Array.isArray(data.headers)) continue;
		const headers: unknown[] = data.headers;
		return headers.filter((header): header is string => typeof header === "string");
	}
	return [];
}

function summaryRows(frame: AskUserAnswerFrame, headers: readonly string[]): string[] {
	const fallbackHeaders = headers.length > 0 ? headers : [frame.requestId];
	if (
		/^(?:The user did not answer|The user dismissed|The pending question|This session has no user)/.test(frame.body)
	) {
		return fallbackHeaders.map((header) => `↳ ${header}: (no answer)`);
	}
	const answers: string[] = [];
	let comment: string | undefined;
	let unanswered: string[] = [];
	for (const line of frame.body.split("\n")) {
		const separator = line.indexOf(": ");
		if (separator < 1) continue;
		const header = line.slice(0, separator);
		const value = line.slice(separator + 2);
		if (header === "The user responded") comment = value;
		else if (header === "Unanswered") unanswered = value.split(", ");
		else answers.push(`↳ ${header}: ${value}`);
	}
	if (comment !== undefined) {
		answers.push(`↳ ${headers[0] ?? unanswered[0] ?? frame.requestId}: ${JSON.stringify(comment)}`);
	} else answers.push(...unanswered.map((header) => `↳ ${header}: (no answer)`));
	return answers.length > 0 ? answers : fallbackHeaders.map((header) => `↳ ${header}: (no answer)`);
}

/** A compact display over the unchanged user-message body; normal mouse dispatch requests the redraw. */
export class AskUserAnswerChip extends MouseRegion {
	private readonly fullBody: Component;

	constructor(frame: AskUserAnswerFrame, headers: readonly string[], fullBody: Component) {
		const rows = summaryRows(frame, headers).map((row) => stripAnsi(row).replace(/\s+/g, " "));
		const summary: Component = {
			render: (width) => rows.map((row) => theme.fg("muted", truncateToWidth(row, width, "…"))),
			invalidate() {},
		};
		const content = new Container();
		content.addChild(summary);
		let expanded = false;
		super(content, (event) => {
			if (event.button !== "left") return undefined;
			if (event.type === "press") return { handled: true, render: false };
			if (event.type !== "click" || (event.clickCount ?? 1) !== 1) return undefined;
			expanded = !expanded;
			content.detachAll();
			content.addChild(expanded ? fullBody : summary);
			return { handled: true };
		});
		this.fullBody = fullBody;
	}

	override invalidate(): void {
		super.invalidate();
		this.fullBody.invalidate();
	}

	dispose(): void {
		this.fullBody.dispose?.();
	}
}
