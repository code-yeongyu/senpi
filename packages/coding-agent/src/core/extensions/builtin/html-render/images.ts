// Local-image preparation, mirroring the desktop's apps/server/src/htmlRender/
// HtmlRender.ts (upstream t3code #15968): absolute-path images are inlined as
// data URIs only after a magic-byte/SVG-root check, so a renamed secret is
// refused, and the page stays within the size caps. Pure byte/string work.

import { readFile, stat } from "node:fs/promises";

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_PAGE_BYTES = 25 * MIB;

export class HtmlRenderImagesNotFoundError extends Error {
	readonly paths: readonly string[];
	constructor(paths: readonly string[]) {
		super(
			`These local images could not be read: ${paths.join(", ")}. Use absolute paths to existing image files, or remove them.`,
		);
		this.name = "HtmlRenderImagesNotFoundError";
		this.paths = paths;
	}
}

export class HtmlRenderImageTooLargeError extends Error {
	constructor(path: string, sizeBytes: number) {
		super(`${path} is ${(sizeBytes / MIB).toFixed(1)} MiB; each local image must be at most 10 MiB.`);
		this.name = "HtmlRenderImageTooLargeError";
	}
}

export class HtmlRenderPageTooLargeError extends Error {
	constructor(sizeBytes: number) {
		super(
			`With its images inlined the page is ${(sizeBytes / MIB).toFixed(1)} MiB; the limit is 25 MiB. Use smaller images.`,
		);
		this.name = "HtmlRenderPageTooLargeError";
	}
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
const LOCAL_IMAGE_PATTERN = new RegExp(
	String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
		String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
	"gid",
);

interface ImageReference {
	readonly start: number;
	readonly end: number;
	readonly path: string;
}

// Elements whose body is not markup: a <script> or <style> body is code the page runs, which may load any
// path it names; a <textarea> or <title> body is text the page only shows.
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);
const TAG_START = /<\/?([a-z][^\s/>]*)/iy;

/** The end of the tag whose attributes start at `from`, skipping quoted values, or -1 when it never ends. */
const tagEnd = (html: string, from: number) => {
	let at = from;
	while (at !== -1 && at < html.length) {
		const char = html[at];
		if (char === ">") return at + 1;
		at = char === '"' || char === "'" ? after(html, char, at + 1) : at + 1;
	}
	return -1;
};

/**
 * The spans of the page that can load a path, in order: every tag (its attributes, an inline handler or
 * style included) and every <script> or <style> body, where a path may be data the script assigns later.
 * Text, <code> and <pre> samples, <textarea> and <title> bodies and comments are only shown, never loaded.
 */
const loadingSpans = (html: string): (readonly [number, number])[] => {
	const spans: (readonly [number, number])[] = [];
	const lower = html.toLowerCase();
	let at = 0;
	while (at < html.length) {
		const open = html.indexOf("<", at);
		if (open === -1) break;
		if (html.startsWith("<!--", open)) {
			at = after(html, "-->", open + 4);
			if (at === -1) break;
			continue;
		}
		TAG_START.lastIndex = open;
		const name = TAG_START.exec(html);
		if (!name) {
			at = open + 1;
			continue;
		}
		const end = tagEnd(html, TAG_START.lastIndex);
		spans.push([open, end === -1 ? html.length : end]);
		if (end === -1) break;
		at = end;
		const element = name[1]?.toLowerCase() ?? "";
		if (html[open + 1] === "/" || !RAW_TEXT_ELEMENTS.has(element)) continue;
		const close = lower.indexOf(`</${element}`, end);
		const bodyEnd = close === -1 ? html.length : close;
		if (element === "script" || element === "style") spans.push([end, bodyEnd]);
		at = bodyEnd;
	}
	return spans;
};

/**
 * The absolute image paths the page loads: a quoted path or url() inside a tag or a <script> or <style>
 * body, such as `src="/abs/x.png"` or script data like `{ src: "/abs/x.png" }` and path arrays. A path only
 * named in text or a <code>/<pre> sample is no reference: it is never read and stays as written.
 */
const findLocalImages = (html: string): ImageReference[] => {
	const spans = loadingSpans(html);
	const pattern = new RegExp(LOCAL_IMAGE_PATTERN.source, LOCAL_IMAGE_PATTERN.flags);
	const references: ImageReference[] = [];
	let span = 0;
	for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
		while (span < spans.length && (spans[span]?.[1] ?? 0) <= match.index) span += 1;
		const loads = (spans[span]?.[0] ?? Number.POSITIVE_INFINITY) <= match.index;
		const path = match.indices?.[2] ?? match.indices?.[3];
		if (!loads || path === undefined) {
			// A quoted mention may have swallowed the start of a real reference: look again one character on.
			pattern.lastIndex = match.index + 1;
			continue;
		}
		references.push({ start: path[0], end: path[1], path: html.slice(path[0], path[1]) });
	}
	return references;
};

const filePathFor = (reference: string) =>
	/^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (path: string) =>
	`data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

const after = (text: string, token: string, from: number) => {
	const at = text.indexOf(token, from);
	return at === -1 ? -1 : at + token.length;
};

const afterDoctype = (text: string, from: number) => {
	let inSubset = false;
	let at = from;
	while (at !== -1 && at < text.length) {
		const char = text[at];
		if (char === '"' || char === "'") at = after(text, char, at + 1);
		else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
		else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
		else if (char === ">" && !inSubset) return at + 1;
		else {
			if (char === "[") inSubset = true;
			else if (char === "]") inSubset = false;
			at += 1;
		}
	}
	return -1;
};

const hasSvgRoot = (text: string) => {
	let at = 0;
	while (at !== -1) {
		while (/\s/.test(text.charAt(at))) at += 1;
		if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
		else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
		else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
		else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
	}
	return false;
};

/** Whether file bytes are an image, whatever the file is named. */
const isImageBytes = (bytes: Uint8Array) => {
	const head = latin1(bytes, 0, 12);
	if (
		head.startsWith("\x89PNG") ||
		head.startsWith("\xff\xd8\xff") ||
		head.startsWith("GIF8") ||
		head.startsWith("\0\0\x01\0") ||
		(head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
		(head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
		/^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
	) {
		return true;
	}
	return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
};

/**
 * Replaces every local image the page loads with a data URI. A loaded path that cannot be read as an
 * image stays as written and is returned in `missing`; the caller decides what that means.
 */
export async function inlineLocalImages(html: string): Promise<{ html: string; missing: string[] }> {
	const references = findLocalImages(html);
	const uniquePaths = [...new Set(references.map((reference) => reference.path))];
	const files = await Promise.all(
		uniquePaths.map(async (path) => {
			try {
				const info = await stat(filePathFor(path));
				return { path, size: info.isFile() ? Number(info.size) : undefined };
			} catch {
				return { path, size: undefined };
			}
		}),
	);
	const oversized = files.find((file) => file.size !== undefined && file.size > MAX_IMAGE_BYTES);
	if (oversized?.size !== undefined) {
		throw new HtmlRenderImageTooLargeError(oversized.path, oversized.size);
	}
	const images = new Map<string, Uint8Array>();
	let readBytes = 0;
	for (const file of files.filter((entry) => entry.size !== undefined)) {
		const bytes = new Uint8Array(await readFile(filePathFor(file.path)));
		if (!isImageBytes(bytes)) continue;
		if (bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new HtmlRenderImageTooLargeError(file.path, bytes.byteLength);
		}
		readBytes += Math.ceil(bytes.byteLength / 3) * 4;
		if (readBytes > MAX_PAGE_BYTES) throw new HtmlRenderPageTooLargeError(readBytes);
		images.set(file.path, bytes);
	}
	const parts: string[] = [];
	let cursor = 0;
	for (const reference of references) {
		const bytes = images.get(reference.path);
		if (bytes === undefined) continue;
		parts.push(
			html.slice(cursor, reference.start),
			dataUriPrefix(reference.path) + Buffer.from(bytes).toString("base64"),
		);
		cursor = reference.end;
	}
	parts.push(html.slice(cursor));
	const inlined = parts.join("");
	if (Buffer.byteLength(inlined) > MAX_PAGE_BYTES) {
		throw new HtmlRenderPageTooLargeError(Buffer.byteLength(inlined));
	}
	const missing = files.filter((file) => !images.has(file.path)).map((file) => file.path);
	return { html: inlined, missing };
}
