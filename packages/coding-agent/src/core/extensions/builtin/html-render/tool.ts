import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { resolvePromptSurface } from "../../../dynamic-prompt/build.ts";
import { defineTool, type ExtensionToolContext } from "../../types.ts";
import { injectHtmlRenderBootstrap } from "./bootstrap.ts";
import { HtmlRenderImagesNotFoundError, inlineLocalImages } from "./images.ts";

// The same input limit as the desktop's html_render. Images belong as absolute
// file paths, which are inlined after the check, so the document the agent
// writes stays small in the tool call; the result details carry it inlined.
const MAX_HTML_CHARACTERS = 512_000;

// The page handed to the host travels in `details` on every RPC record that carries this result
// (tool_execution_end, message_end, entry_appended), and every handed page travels together in the
// records that carry the transcript (get_messages, get_tree, agent_end). An RPC record is at most
// MAX_RPC_LINE_CHARACTERS (16 Mi); a longer one drops an attach connection. So one page carries its
// images inlined only up to MAX_HANDED_PAGE_CHARACTERS, and a session's image-inlined pages together only
// up to MAX_HANDED_PAGES_CHARACTERS, which leaves room for JSON escaping and the rest of the transcript.
// Past either, the page is handed as written, and its images reach only a host that has this disk.
// A page handed as written (`imagesInlined: false`) is not counted: it carries at most MAX_HTML_CHARACTERS,
// in `details.html` and again in the call's arguments, so those pages are bounded per page, not per session. Only a
// call the model issued is recorded in the transcript. A call another tool makes through ctx.executeTool() (id
// `<parent>/<n>`) or an extension makes through pi.executeTool() (id `codemode-<uuid>`) is not, so its page only
// rides its own tool_execution_end and is held to the per-page cap alone.
export const MAX_HANDED_PAGE_CHARACTERS = 2 * 1024 * 1024;
export const MAX_HANDED_PAGES_CHARACTERS = 6 * 1024 * 1024;

const Params = Type.Object({
	html: Type.String({
		description: `A complete, self-contained HTML document, at most ${MAX_HTML_CHARACTERS} characters. Pass screenshots and other images as absolute file paths (<img src="/abs/path.png">), never as base64.`,
		minLength: 1,
	}),
	title: Type.String({ description: "Short name for the page.", minLength: 1, maxLength: 200 }),
	height: Type.Optional(
		Type.Integer({
			description: "Frame height hint in CSS pixels, 80-2000. Defaults to the page's natural height.",
		}),
	),
});

const OUTPUT_DIR = ".senpi/html-pages";

const showHtmlPageName = "show_html_page";

const BASE64_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi;

/**
 * The limit is checked here rather than in the schema so the refusal says what to do: a report
 * usually goes over it because its screenshots are base64, and the fix is to pass them as absolute
 * file paths, which this tool inlines itself after the check (senpi#3418).
 */
function assertWithinInputLimit(html: string): void {
	if (html.length <= MAX_HTML_CHARACTERS) return;
	const images = html.match(BASE64_IMAGE) ?? [];
	const imageCharacters = images.reduce((total, image) => total + image.length, 0);
	const advice =
		images.length > 0
			? ` ${images.length} base64 images make up ${imageCharacters} of them. Save each image to a file and reference it by absolute file path (<img src="/abs/path/shot.png">); show_html_page inlines local images itself, and they do not count against this limit.`
			: " Shorten the document, or move large images out of it as absolute file paths, which show_html_page inlines itself.";
	throw new Error(
		`The page is ${html.length} characters; show_html_page accepts at most ${MAX_HTML_CHARACTERS} characters.${advice}`,
	);
}

export interface ShowHtmlPageDetails {
	path: string;
	title: string;
	height: number | undefined;
	prepared: boolean;
	/**
	 * The page for a host that publishes it itself (the desktop renders it in the thread), never part
	 * of the model-visible content. When it fits MAX_HANDED_PAGE_CHARACTERS its local images are inlined
	 * as data URIs, so it needs no file on this machine and a viewer on another machine renders the same
	 * page; otherwise it is the page as the agent wrote it, and `imagesInlined` is false.
	 */
	html: string;
	imagesInlined: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Pages handed but not yet in the session's entries, by tool call id: calls in one turn run concurrently,
 * and each result is recorded only after it returns. One ledger belongs to one extension instance, so it is
 * released with the session that loaded it, and the extension clears it when a run ends (index.ts). Only
 * calls the model issued (ctx.issuedByModel, which the session sets for agent-loop and Cursor exec-frame
 * calls) are held: a call another tool makes through ctx.executeTool() (id <parent>/<n>) or an extension
 * makes through pi.executeTool() (id codemode-<uuid>) is never recorded in the transcript.
 */
export type PendingHandedPages = Map<string, number>;
/** Characters of inlined pages this session already hands to the host, across every branch. */
function inlinedPageCharacters(ctx: ExtensionToolContext, pending: PendingHandedPages): number {
	let total = 0;
	const recorded = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== showHtmlPageName) continue;
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

const clampHeight = (height: number | undefined) =>
	height === undefined ? undefined : Math.min(2000, Math.max(80, Math.round(height)));

/**
 * Whether this session's host shows the page. The OmO desktop opens every session it renders with
 * `open_session.promptSurface: "app"` and publishes a completed call from its details; every other
 * surface (terminal, chat bridge, or none named) only gets the file. The result states which happened,
 * because the model trusts it in later turns too (senpi#6273).
 */
const hostRendersPage = (ctx: ExtensionToolContext): boolean =>
	(ctx.getSystemPromptOptions?.().surface ?? resolvePromptSurface(process.env)) === "app";

export function createShowHtmlPageTool(pending: PendingHandedPages = new Map()) {
	return defineTool<typeof Params, ShowHtmlPageDetails>({
		name: showHtmlPageName,
		label: "Show HTML Page",
		description:
			"Show a finished self-contained HTML page (chart, table, diagram, mockup) to the reader. " +
			"Load the visualize skill before building the page. " +
			"No network: inline every script, style and image (data: URIs). A <script src>, stylesheet link, font, image " +
			"or fetch that points at a URL (a CDN included) is refused, and the page comes out blank or broken. " +
			"Local images written as absolute file paths " +
			"are inlined automatically after a magic-byte check (a renamed non-image is refused); pass screenshots " +
			"that way, never as base64 data: URIs, since the page is limited to 512000 characters before images are " +
			"inlined. In the OmO desktop thread the page renders inline above your reply; elsewhere it is only " +
			"saved to a file and not displayed. The result says which happened.",
		exposure: "search",
		allowLazyActivation: true,
		searchKeywords: ["html", "chart", "table", "diagram", "visualize", "render page", "mockup"],
		parameters: Params,
		async execute(toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			assertWithinInputLimit(params.html);
			const inlined = await inlineLocalImages(params.html);
			// A page with a broken image is refused, as the desktop refuses to publish one, so the
			// agent learns which path to fix instead of being told the page was shown.
			if (inlined.missing.length > 0) throw new HtmlRenderImagesNotFoundError(inlined.missing);
			const prepared = injectHtmlRenderBootstrap(inlined.html);
			const height = clampHeight(params.height);
			const dir = join(ctx.cwd, OUTPUT_DIR);
			await mkdir(dir, { recursive: true });
			const safeName =
				params.title
					.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 60) || "page";
			const path = join(dir, `${safeName}-${Date.now().toString(36)}.html`);
			await writeFile(path, prepared, "utf8");
			const inTranscript = ctx.issuedByModel;
			const alreadyHanded = inTranscript ? inlinedPageCharacters(ctx, pending) : 0;
			const fitsPage = inlined.html.length <= MAX_HANDED_PAGE_CHARACTERS;
			const imagesInlined = fitsPage && alreadyHanded + inlined.html.length <= MAX_HANDED_PAGES_CHARACTERS;
			if (imagesInlined && inTranscript) pending.set(toolCallId, inlined.html.length);
			return {
				content: [
					{
						type: "text",
						text:
							(hostRendersPage(ctx)
								? `The page was shown to the reader inline above your reply. A copy is saved at ${path}. `
								: `Wrote the page to ${path}. It was not displayed in this interface. `) +
							(imagesInlined
								? "Local images were inlined."
								: fitsPage
									? `Local images were inlined into the saved copy, but this session's pages already carry ${alreadyHanded} of the ${MAX_HANDED_PAGES_CHARACTERS} characters of images a session can carry to a viewer, so a viewer on another machine will not see this page's images.`
									: `Local images were inlined into the saved copy, but with them the page is ${inlined.html.length} characters, over the ${MAX_HANDED_PAGE_CHARACTERS} a page can carry to a viewer, so a viewer on another machine will not see the images. Use smaller images to show them everywhere.`),
					},
				],
				details: {
					path,
					title: params.title,
					height,
					prepared: true,
					html: imagesInlined ? inlined.html : params.html,
					imagesInlined,
				},
			};
		},
	});
}
