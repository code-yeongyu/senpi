// Local-image preparation, mirroring the desktop's apps/server/src/htmlRender/
// HtmlRender.ts (upstream t3code #15968): absolute-path images are inlined as
// data URIs only after a magic-byte/SVG-root check, so a renamed secret is
// refused, and the page stays within the size caps. Pure byte/string work.

import { open } from "node:fs/promises";
import { findLocalImages, IMAGE_MIME_TYPES } from "./image-references.ts";

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

const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Reads an image from its own descriptor, at most MAX_IMAGE_BYTES + 1 bytes (senpi#2840): the size
 * check and the read share one open file, so an image that grows after the check cannot make the
 * read unbounded — past the cap the read stops and the image is refused.
 */
async function readImageWithinLimit(path: string): Promise<Uint8Array> {
	const handle = await open(path, "r");
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (total <= MAX_IMAGE_BYTES) {
			const want = Math.min(READ_CHUNK_BYTES, MAX_IMAGE_BYTES + 1 - total);
			const chunk = Buffer.alloc(want);
			const { bytesRead } = await handle.read(chunk, 0, want, null);
			if (bytesRead === 0) break;
			chunks.push(bytesRead === want ? chunk : chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
	} finally {
		await handle.close();
	}
	if (total > MAX_IMAGE_BYTES) throw new HtmlRenderImageTooLargeError(path, total);
	return Buffer.concat(chunks, total);
}

/**
 * Replaces every local image the page loads with a data URI. A loaded path that cannot be read as an
 * image stays as written and is returned in `missing`; the caller decides what that means.
 */
export async function inlineLocalImages(html: string): Promise<{ html: string; missing: string[] }> {
	const references = findLocalImages(html);
	const uniquePaths = [...new Set(references.map((reference) => reference.path))];
	const images = new Map<string, Uint8Array>();
	let readBytes = 0;
	for (const path of uniquePaths) {
		let bytes: Uint8Array;
		try {
			bytes = await readImageWithinLimit(filePathFor(path));
		} catch (error) {
			if (error instanceof HtmlRenderImageTooLargeError) throw error;
			continue;
		}
		if (!isImageBytes(bytes)) continue;
		readBytes += Math.ceil(bytes.byteLength / 3) * 4;
		if (readBytes > MAX_PAGE_BYTES) throw new HtmlRenderPageTooLargeError(readBytes);
		images.set(path, bytes);
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
	const missing = uniquePaths.filter((path) => !images.has(path));
	return { html: inlined, missing };
}
