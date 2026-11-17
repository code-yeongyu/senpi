import type { ReadonlySessionManager } from "../../../session-manager.ts";

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

export type HandedPageSession = Pick<ReadonlySessionManager, "getEntries" | "getSessionId">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Pages handed but not yet in the session's entries: calls in one turn run concurrently, and each result is recorded
// only after it returns. Keyed by session id, then tool call id. Each is dropped once its result is in the entries or
// the session shuts down.
const handedNotYetRecorded = new Map<string, Map<string, number>>();

/** Drop what a session's calls still hold, when its runtime shuts down. */
export function forgetHandedPages(sessionId: string): void {
	handedNotYetRecorded.delete(sessionId);
}

/** Characters of inlined pages this session already hands to the host, across every branch. */
function inlinedPageCharacters(session: HandedPageSession): number {
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
	const sessionId = session.getSessionId();
	const pending = handedNotYetRecorded.get(sessionId);
	for (const [toolCallId, characters] of pending ?? []) {
		if (recorded.has(toolCallId)) pending?.delete(toolCallId);
		else total += characters;
	}
	if (pending?.size === 0) handedNotYetRecorded.delete(sessionId);
	return total;
}

/**
 * Whether a page of `characters` inlined characters still fits the session's budget, and what the session already
 * hands. A page that fits is held for the session until its result is in the entries.
 */
export function reserveHandedPage(
	session: HandedPageSession,
	toolCallId: string,
	characters: number,
): { readonly inlined: boolean; readonly alreadyHanded: number } {
	const alreadyHanded = inlinedPageCharacters(session);
	const inlined = alreadyHanded + characters <= MAX_HANDED_PAGES_CHARACTERS;
	if (inlined) {
		const sessionId = session.getSessionId();
		const pending = handedNotYetRecorded.get(sessionId) ?? new Map<string, number>();
		pending.set(toolCallId, characters);
		handedNotYetRecorded.set(sessionId, pending);
	}
	return { inlined, alreadyHanded };
}

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
	if (page.imagesInlined) return `${where}Local images were inlined.`;
	return page.fitsPage
		? `${where}Local images were inlined into the saved copy, but this session's pages already carry ${page.alreadyHanded} of the ${MAX_HANDED_PAGES_CHARACTERS} characters of images a session can carry to a viewer, so a viewer on another machine will not see this page's images.`
		: `${where}Local images were inlined into the saved copy, but with them the page is ${page.inlinedLength} characters, over the ${MAX_HANDED_PAGE_CHARACTERS} a page can carry to a viewer, so a viewer on another machine will not see the images. Use smaller images to show them everywhere.`;
}
