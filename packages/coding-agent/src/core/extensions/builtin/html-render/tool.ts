import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { resolvePromptSurface } from "../../../dynamic-prompt/build.ts";
import { defineTool, type ExtensionToolContext } from "../../types.ts";
import { injectHtmlRenderBootstrap } from "./bootstrap.ts";
import {
	handedPageText,
	MAX_HANDED_PAGE_CHARACTERS,
	type PendingHandedPages,
	reserveHandedPage,
	SHOW_HTML_PAGE_NAME,
} from "./handed-pages.ts";
import { HtmlRenderImagesNotFoundError, inlineLocalImages } from "./images.ts";

// The same input limit as the desktop's html_render. Images belong as absolute
// file paths, which are inlined after the check, so the document the agent
// writes stays small in the tool call; the result details carry it inlined.
const MAX_HTML_CHARACTERS = 512_000;

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
	/**
	 * The exact text part this call's result carries, so a later step that rewrites the result (the brain's page
	 * budget for a hand) finds the page's own text whatever a `tool_result` handler added around it (senpi#6934).
	 */
	resultText: string;
}

const clampHeight = (height: number | undefined) =>
	height === undefined ? undefined : Math.min(2000, Math.max(80, Math.round(height)));

/**
 * Whether this session's host shows the page. The OmO desktop opens every session it renders with
 * `open_session.promptSurface: "app"` and publishes a completed call from its details; every other
 * surface (terminal, chat bridge, or none named) only gets the file. The result states which happened,
 * because the model trusts it in later turns too (senpi#6273). On a hand (brain/hand split) `ctx.promptSurface` is the
 * brain session's, sent with the call (senpi#6921); a runtime that knows none falls back to the environment.
 */
const hostRendersPage = (ctx: ExtensionToolContext): boolean =>
	(ctx.promptSurface ?? resolvePromptSurface(process.env)) === "app";

/** The show_html_page tool of one extension instance, holding its pages not yet recorded in `pending`. */
export function createShowHtmlPageTool(pending: PendingHandedPages = new Map()) {
	return defineTool<typeof Params, ShowHtmlPageDetails>({
		name: SHOW_HTML_PAGE_NAME,
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
			// A hand (brain/hand split) has no session: the transcript its page joins is the brain's, which counts the page
			// when the result arrives (`withHandPageBudget`, senpi#6921); here it is held to the per-page cap alone.
			const inTranscript = ctx.issuedByModel && ctx.sessionManager !== undefined;
			const fitsPage = inlined.html.length <= MAX_HANDED_PAGE_CHARACTERS;
			const { inlined: imagesInlined, alreadyHanded } =
				fitsPage && inTranscript
					? reserveHandedPage(ctx.sessionManager, pending, toolCallId, inlined.html.length)
					: { inlined: fitsPage, alreadyHanded: 0 };
			const resultText = handedPageText({
				path,
				shown: hostRendersPage(ctx),
				imagesInlined,
				fitsPage,
				alreadyHanded,
				inlinedLength: inlined.html.length,
			});
			return {
				content: [{ type: "text", text: resultText }],
				details: {
					path,
					title: params.title,
					height,
					prepared: true,
					html: imagesInlined ? inlined.html : params.html,
					imagesInlined,
					resultText,
				},
			};
		},
	});
}
