import type { AgentEvent, AgentToolCall, ToolHost } from "@earendil-works/pi-agent-core";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import type { PromptSurface } from "../../core/dynamic-prompt/build.ts";
import {
	type HandedPageSession,
	handedPageText,
	type PendingHandedPages,
	reserveHandedPage,
	SHOW_HTML_PAGE_NAME,
} from "./handed-pages.ts";

/** The brain session whose transcript a hand's pages join. */
export interface HandPageBudgetSession {
	readonly sessionManager: HandedPageSession;
	readonly promptSurface: PromptSurface;
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
	readonly path: string;
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
 * so, and whatever the hand's `tool_result` handlers added stays (senpi#6921, senpi#6928).
 */
export function withHandPageBudget(host: ToolHost, session: HandPageBudgetSession): ToolHost {
	// A hand is installed only between runs, so this ledger never outlives the pages it holds by more than one run.
	const pending: PendingHandedPages = new Map();
	return {
		...(host.deviceFiles === undefined ? {} : { deviceFiles: host.deviceFiles.bind(host) }),
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
 * The page's own text is the text part that names its saved copy; it alone is replaced, and every other part (what a
 * hand-side `tool_result` handler added) stays where it is. A result whose page text is gone gets the text first.
 */
function applied(downgrade: PageDowngrade, content: ResultContent): PageOverride {
	const own = content.findIndex((part) => part.type === "text" && part.text.includes(downgrade.path));
	const text = { type: "text" as const, text: downgrade.text };
	return {
		content: own === -1 ? [text, ...content] : content.map((part, index) => (index === own ? text : part)),
		details: downgrade.details,
	};
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
	return {
		path: details.path,
		text: handedPageText({
			path: details.path,
			shown: session.promptSurface === "app",
			imagesInlined: false,
			fitsPage: true,
			alreadyHanded: reservation.alreadyHanded,
			inlinedLength: details.html.length,
		}),
		details: { ...details, html: written, imagesInlined: false },
	};
}
