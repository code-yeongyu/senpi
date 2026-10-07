import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionToolContext } from "../../types.ts";
import { injectHtmlRenderBootstrap } from "./bootstrap.ts";
import { inlineLocalImages } from "./images.ts";

// The same input limit as the desktop's html_render. Images belong as absolute
// file paths, which are inlined after the check, so the document itself stays
// small: it travels in the tool call and again in the result details.
const MAX_HTML_CHARACTERS = 512_000;

const Params = Type.Object({
	html: Type.String({
		description: "A complete, self-contained HTML document.",
		minLength: 1,
		maxLength: MAX_HTML_CHARACTERS,
	}),
	title: Type.String({ description: "Short name for the page.", minLength: 1, maxLength: 200 }),
	height: Type.Optional(
		Type.Integer({
			description: "Frame height hint in CSS pixels, 80-2000. Defaults to the page's natural height.",
		}),
	),
});

const OUTPUT_DIR = ".senpi/html-pages";

export interface ShowHtmlPageDetails {
	path: string;
	title: string;
	height: number | undefined;
	prepared: boolean;
	missingImages?: string[];
	/**
	 * The page as the agent wrote it, for a host that publishes it itself (the
	 * desktop renders it in the thread). Never part of the model-visible content.
	 */
	html: string;
}

const clampHeight = (height: number | undefined) =>
	height === undefined ? undefined : Math.min(2000, Math.max(80, Math.round(height)));

export const showHtmlPageTool = defineTool<typeof Params, ShowHtmlPageDetails>({
	name: "show_html_page",
	label: "Show HTML Page",
	description:
		"Show a finished self-contained HTML page (chart, table, diagram, mockup) to the reader. " +
		"No network: inline every script, style and image (data: URIs). A <script src>, stylesheet link, font, image " +
		"or fetch that points at a URL (a CDN included) is refused, and the page comes out blank or broken. " +
		"Local images written as absolute file paths " +
		"are inlined automatically after a byte check. In the desktop thread this renders inline above your " +
		"reply; elsewhere it is written to a file you can open in the desktop.",
	promptSnippet: "show_html_page: show a self-contained HTML page (chart/table/diagram) to the reader",
	promptGuidelines: [
		"No network: inline every script, style and image (data: URIs); a CDN <script src> or remote font is refused and leaves the page blank.",
		"Absolute-path local images are inlined after a magic-byte check; a renamed non-image is refused.",
	],
	parameters: Params,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
		const inlined = await inlineLocalImages(params.html);
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
		const missing = inlined.missing.length === 0 ? undefined : inlined.missing;
		return {
			content: [
				{
					type: "text",
					text:
						`Wrote the page to ${path}. Open it in the desktop to see it rendered with your theme. ` +
						(missing === undefined
							? "Local images were inlined."
							: `Some local images could not be read and were left as written: ${missing.join(", ")}.`),
				},
			],
			details: {
				path,
				title: params.title,
				height,
				prepared: true,
				...(missing ? { missingImages: missing } : {}),
				html: params.html,
			},
		};
	},
});
