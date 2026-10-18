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

const findLocalImages = (html: string): ImageReference[] =>
	Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
		const span = match.indices?.[2] ?? match.indices?.[3];
		return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
	});

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

/** Replaces every local image reference with a data URI; unreadable paths throw. */
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
