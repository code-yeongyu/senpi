import type { ReadonlySessionManager } from "../../core/session-manager.ts";

// The page handed to the host travels in `details` on every RPC record that carries a show_html_page result
// (tool_execution_end, message_end, entry_appended), and every handed page travels together in the records that carry
// the transcript (get_messages, get_tree, agent_end). An RPC record is at most MAX_RPC_LINE_CHARACTERS (16 Mi); a longer
// one drops an attach connection. So one page carries its images inlined only up to MAX_HANDED_PAGE_CHARACTERS, and a
// session's image-inlined pages together only up to MAX_HANDED_PAGES_CHARACTERS, which leaves room for JSON escaping
// and the rest of the transcript. Past either, the page is handed as written, and its images reach only a host that has
// this disk. A page handed as written (`imagesInlined: false`) is not counted: it carries at most the tool's input limit,
// in `details.html` and again in the call's arguments, so those pages are bounded per page, not per session. Only a call
// the model issued is recorded in the transcript. A call another tool makes through ctx.executeTool() (id
// `<parent>/<n>`) or an extension makes through pi.executeTool() (id `codemode-<uuid>`) is not, so its page only rides
// its own tool_execution_end and is held to the per-page cap alone. A page a hand runs (brain/hand split) joins the
// brain's transcript, so the brain counts it when the result arrives (`withHandPageBudget`, senpi#6921).
export const MAX_HANDED_PAGE_CHARACTERS = 2 * 1024 * 1024;
export const MAX_HANDED_PAGES_CHARACTERS = 6 * 1024 * 1024;

export const SHOW_HTML_PAGE_NAME = "show_html_page";

export type HandedPageSession = Pick<ReadonlySessionManager, "getEntries">;

/**
 * Pages handed but not yet in the session's entries, by tool call id: calls in one turn run concurrently,
 * and each result is recorded only after it returns. One ledger belongs to one session's page producer (the
 * html-render extension instance, or the brain's ToolHost for a hand), so it is released with it. Only
 * calls the model issued (ctx.issuedByModel, which the session sets for agent-loop and Cursor exec-frame
 * calls) are held: a call another tool makes through ctx.executeTool() (id <parent>/<n>) or an extension
 * makes through pi.executeTool() (id codemode-<uuid>) is never recorded in the transcript.
 */
export type PendingHandedPages = Map<string, number>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Characters of inlined pages this session already hands to the host, across every branch. */
function inlinedPageCharacters(session: HandedPageSession, pending: PendingHandedPages): number {
	let total = 0;
	const recorded = new Set<string>();
	for (const entry of session.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== SHOW_HTML_PAGE_NAME) continue;
		recorded.add(entry.message.toolCallId);
		const details: unknown = entry.message.details;
		if (isRecord(details) && details.imagesInlined === true && typeof details.html === "string")
			total += details.html.length;
	}
	for (const [toolCallId, characters] of pending) {
		if (recorded.has(toolCallId)) pending.delete(toolCallId);
		else total += characters;
	}
	return total;
}

/**
 * Whether a page of `characters` inlined characters still fits the session's budget, and what the session already
 * hands. A page that fits is held in `pending` until its result is in the entries.
 */
export function reserveHandedPage(
	session: HandedPageSession,
	pending: PendingHandedPages,
	toolCallId: string,
	characters: number,
): { readonly inlined: boolean; readonly alreadyHanded: number } {
	const alreadyHanded = inlinedPageCharacters(session, pending);
	const inlined = alreadyHanded + characters <= MAX_HANDED_PAGES_CHARACTERS;
	if (inlined) pending.set(toolCallId, characters);
	return { inlined, alreadyHanded };
}

/** What a page result says when its images were inlined for the viewer. */
export const IMAGES_INLINED = "Local images were inlined.";

/** What a page result says instead of IMAGES_INLINED when the session's budget has no room for its images. */
export const overSessionBudgetText = (alreadyHanded: number): string =>
	`Local images were inlined into the saved copy, but this session's pages already carry ${alreadyHanded} of the ${MAX_HANDED_PAGES_CHARACTERS} characters of images a session can carry to a viewer, so a viewer on another machine will not see this page's images.`;

/** The result text of a written page: where it went, and whether a viewer on another machine sees its images. */
export function handedPageText(page: {
	readonly path: string;
	readonly shown: boolean;
	readonly imagesInlined: boolean;
	readonly fitsPage: boolean;
	readonly alreadyHanded: number;
	readonly inlinedLength: number;
}): string {
	const where = page.shown
		? `The page was shown to the reader inline above your reply. A copy is saved at ${page.path}. `
		: `Wrote the page to ${page.path}. It was not displayed in this interface. `;
	if (page.imagesInlined) return `${where}${IMAGES_INLINED}`;
	return page.fitsPage
		? `${where}${overSessionBudgetText(page.alreadyHanded)}`
		: `${where}Local images were inlined into the saved copy, but with them the page is ${page.inlinedLength} characters, over the ${MAX_HANDED_PAGE_CHARACTERS} a page can carry to a viewer, so a viewer on another machine will not see the images. Use smaller images to show them everywhere.`;
}
