import type { AgentEvent, AgentToolCall, ToolHost } from "@earendil-works/pi-agent-core";
import type { JsonObject, TextContent } from "@earendil-works/pi-ai";
import type { PromptSurface } from "../../../dynamic-prompt/build.ts";
import { type HandedPageSession, handedPageText, reserveHandedPage, SHOW_HTML_PAGE_NAME } from "./handed-pages.ts";

/** The brain session whose transcript a hand's pages join. */
export interface HandPageBudgetSession {
	readonly sessionManager: HandedPageSession;
	readonly promptSurface: PromptSurface;
}

/** What replaces a page result's content and details when the page is handed as written instead. */
interface PageOverride {
	readonly content: TextContent[];
	readonly details: JsonObject;
}

// A hand's result details arrive JSON-decoded over the hand link, so an object there is a JSON object.
const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A hand (brain/hand split) runs show_html_page without the session's transcript, so it holds a page to the per-page
 * cap alone. This wraps the brain's ToolHost for that hand and applies the session's page budget to each page the hand
 * hands back, before its result is emitted or recorded: a page over the budget is handed as written, with the result
 * text saying so, as a session that ran the tool itself would (senpi#6921).
 */
export function withHandPageBudget(host: ToolHost, session: HandPageBudgetSession): ToolHost {
	return {
		...(host.deviceFiles === undefined ? {} : { deviceFiles: host.deviceFiles.bind(host) }),
		async execute(call, options) {
			// One decision per call: the result's tool_execution_end, its message events and the returned message agree.
			const decisions = new Map<string, PageOverride | undefined>();
			const budgeted = (toolCallId: string, toolName: string, details: unknown): PageOverride | undefined => {
				if (toolName !== SHOW_HTML_PAGE_NAME) return undefined;
				if (!decisions.has(toolCallId))
					decisions.set(toolCallId, overBudget(call.calls, toolCallId, details, session));
				return decisions.get(toolCallId);
			};
			const emit = (event: AgentEvent) => options.emit(budgetedEvent(event, budgeted));
			const outcome = await host.execute(call, { ...options, emit });
			return {
				...outcome,
				messages: outcome.messages.map((message) => ({
					...message,
					...budgeted(message.toolCallId, message.toolName, message.details),
				})),
			};
		},
	};
}

function budgetedEvent(
	event: AgentEvent,
	budgeted: (toolCallId: string, toolName: string, details: unknown) => PageOverride | undefined,
): AgentEvent {
	if (event.type === "tool_execution_end") {
		const override = budgeted(event.toolCallId, event.toolName, event.result.details);
		return override === undefined ? event : { ...event, result: { ...event.result, ...override } };
	}
	if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
		const override = budgeted(event.message.toolCallId, event.message.toolName, event.message.details);
		return override === undefined ? event : { ...event, message: { ...event.message, ...override } };
	}
	return event;
}

/** The page handed as written when the session's budget has no room for it; undefined when it keeps its images. */
function overBudget(
	calls: readonly AgentToolCall[],
	toolCallId: string,
	details: unknown,
	session: HandPageBudgetSession,
): PageOverride | undefined {
	const written = calls.find((call) => call.id === toolCallId)?.arguments.html;
	if (
		!isJsonObject(details) ||
		details.imagesInlined !== true ||
		typeof details.html !== "string" ||
		typeof details.path !== "string" ||
		typeof written !== "string"
	)
		return undefined;
	const reservation = reserveHandedPage(session.sessionManager, toolCallId, details.html.length);
	if (reservation.inlined) return undefined;
	const text: TextContent = {
		type: "text",
		text: handedPageText({
			path: details.path,
			shown: session.promptSurface === "app",
			imagesInlined: false,
			fitsPage: true,
			alreadyHanded: reservation.alreadyHanded,
			inlinedLength: details.html.length,
		}),
	};
	return { content: [text], details: { ...details, html: written, imagesInlined: false } };
}
