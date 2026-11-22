import type { Agent, AgentEvent, AgentToolCall, ToolHost } from "@earendil-works/pi-agent-core";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type HandedPageSession,
	handedPageText,
	type PendingHandedPages,
	reserveHandedPage,
	SHOW_HTML_PAGE_NAME,
} from "./handed-pages.ts";

/** The brain session whose transcript a hand's pages join. */
export interface HandPageBudgetSession {
	/** Its runs: when one ends, every page it handed is recorded or never will be. */
	readonly agent: Pick<Agent, "subscribe">;
	readonly sessionManager: HandedPageSession;
	/** Whether its client shows a page inline (`inline_html`, senpi#6346). */
	readonly rendersHtmlInline: boolean;
}

type ResultContent = ToolResultMessage["content"];

/** A page result handed as written instead: its content with the page's own text replaced, and its details. */
interface PageOverride {
	readonly content: ResultContent;
	readonly details: JsonObject;
}

/** What the page's result says without its content: the decision is made once per call, the content kept per copy. */
interface PageDowngrade {
	readonly text: string;
	/** The page's own text part as the tool emitted it (`details.resultText`), when the result names it. */
	readonly ownText: string | undefined;
	readonly details: JsonObject;
}

/** The part of a show_html_page result the budget reads and rewrites. */
interface PageResult {
	readonly content: ResultContent;
	readonly details?: unknown;
}

// A hand's result details arrive JSON-decoded over the hand link, so an object there is a JSON object.
const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A hand (brain/hand split) runs show_html_page without the session's transcript, so it holds a page to the per-page
 * cap alone. This wraps the brain's ToolHost for that hand and applies the session's page budget to each page the hand
 * hands back, before its result is emitted or recorded: a page over the budget is handed as written, its own text saying
 * so, and whatever the hand's `tool_result` handlers added stays (senpi#6921, senpi#6928). The wrapper holds the pages it
 * let through until they are recorded; it empties that ledger when a run of the session ends, as the extension does with
 * its own, and `close` ends it with the session's link to the hand (senpi#6932).
 */
export function withHandPageBudget(
	host: ToolHost & { close(): void },
	session: HandPageBudgetSession,
): ToolHost & { close(): void } {
	const pending: PendingHandedPages = new Map();
	const unsubscribe = session.agent.subscribe((event) => {
		if (event.type === "agent_end") pending.clear();
	});
	return {
		...(host.deviceFiles === undefined ? {} : { deviceFiles: host.deviceFiles.bind(host) }),
		close() {
			unsubscribe();
			host.close();
		},
		async execute(call, options) {
			// One decision per call: the result's tool_execution_end, its message events and the returned message agree.
			const decisions = new Map<string, PageDowngrade | undefined>();
			const budgeted = (toolCallId: string, toolName: string, result: PageResult): PageOverride | undefined => {
				if (toolName !== SHOW_HTML_PAGE_NAME) return undefined;
				if (!decisions.has(toolCallId))
					decisions.set(toolCallId, overBudget(call.calls, toolCallId, result.details, session, pending));
				const downgrade = decisions.get(toolCallId);
				return downgrade === undefined ? undefined : applied(downgrade, result.content);
			};
			const emit = (event: AgentEvent) => options.emit(budgetedEvent(event, budgeted));
			const outcome = await host.execute(call, { ...options, emit });
			return {
				...outcome,
				messages: outcome.messages.map((message) => ({
					...message,
					...budgeted(message.toolCallId, message.toolName, message),
				})),
			};
		},
	};
}

function budgetedEvent(
	event: AgentEvent,
	budgeted: (toolCallId: string, toolName: string, result: PageResult) => PageOverride | undefined,
): AgentEvent {
	if (event.type === "tool_execution_end") {
		const override = budgeted(event.toolCallId, event.toolName, event.result);
		return override === undefined ? event : { ...event, result: { ...event.result, ...override } };
	}
	if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
		const override = budgeted(event.message.toolCallId, event.message.toolName, event.message);
		return override === undefined ? event : { ...event, message: { ...event.message, ...override } };
	}
	return event;
}

/**
 * The page's own text is the text part equal to the one the tool emitted (`details.resultText`), wherever a hand-side
 * `tool_result` handler moved it; it alone is replaced, and every other part stays where it is. When no part equals it
 * (a handler rewrote it), nothing is replaced and the over-budget sentence is appended as its own part (senpi#6934).
 * A hand on an older version emits no `resultText`; its page's own text is then found by `olderHandOwnText`, and a
 * result with no text part gets the sentence first (senpi#6932).
 */
function applied(downgrade: PageDowngrade, content: ResultContent): PageOverride {
	const { ownText } = downgrade;
	const own =
		ownText === undefined
			? olderHandOwnText(downgrade, content)
			: content.findIndex((part) => part.type === "text" && part.text === ownText);
	const text = { type: "text" as const, text: downgrade.text };
	const unmatched = ownText === undefined ? [text, ...content] : [...content, text];
	return {
		content: own === -1 ? unmatched : content.map((part, index) => (index === own ? text : part)),
		details: downgrade.details,
	};
}

/**
 * A hand on a release from before senpi#6934 sends no `details.resultText`. Its page text is then the first text part
 * that names the page's saved copy, else the first text part, as the brain read it before the marker (senpi#6937).
 */
function olderHandOwnText(downgrade: PageDowngrade, content: ResultContent): number {
	const path = downgrade.details.path;
	const named =
		typeof path === "string" ? content.findIndex((part) => part.type === "text" && part.text.includes(path)) : -1;
	return named === -1 ? content.findIndex((part) => part.type === "text") : named;
}

/** The page handed as written when the session's budget has no room for it; undefined when it keeps its images. */
function overBudget(
	calls: readonly AgentToolCall[],
	toolCallId: string,
	details: unknown,
	session: HandPageBudgetSession,
	pending: PendingHandedPages,
): PageDowngrade | undefined {
	const written = calls.find((call) => call.id === toolCallId)?.arguments.html;
	if (
		!isJsonObject(details) ||
		details.imagesInlined !== true ||
		typeof details.html !== "string" ||
		typeof details.path !== "string" ||
		typeof written !== "string"
	)
		return undefined;
	const reservation = reserveHandedPage(session.sessionManager, pending, toolCallId, details.html.length);
	if (reservation.inlined) return undefined;
	const text = handedPageText({
		path: details.path,
		shown: session.rendersHtmlInline,
		imagesInlined: false,
		fitsPage: true,
		alreadyHanded: reservation.alreadyHanded,
		inlinedLength: details.html.length,
	});
	return {
		text,
		ownText: typeof details.resultText === "string" ? details.resultText : undefined,
		details: { ...details, html: written, imagesInlined: false, resultText: text },
	};
}
