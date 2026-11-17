// The local image paths an HTML page loads, read the way a browser parses the page (senpi#6915). Only a loading
// context loads a path: a src, srcset, poster, href, data or background attribute, url() in a style attribute or
// a <style> body, and a quoted path in a <script> body or an inline handler, which may be data the script assigns
// later. Any other attribute (alt, title, value, data-*), text, raw text such as <xmp> or <noscript>, a comment
// and a CDATA section only show a path, so it is never read and stays as written.

export const IMAGE_MIME_TYPES: Record<string, string> = {
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
const IMAGE_PATH = new RegExp(String.raw`^${ABSOLUTE_PATH}[^\r\n]{0,2048}\.(?:${IMAGE_EXTENSIONS})$`, "i");
const UNQUOTED_URL = String.raw`url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`;
// Group 2 or 3 holds the path. In CSS a quoted path loads only inside url(); in a script any quoted path may.
const CSS_URL = new RegExp(
	String.raw`url\(\s*(["'])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1\s*\)|${UNQUOTED_URL}`,
	"gid",
);
const SCRIPT_PATH = new RegExp(
	String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1|${UNQUOTED_URL}`,
	"gid",
);

const URL_ATTRIBUTES = new Set(["src", "poster", "href", "xlink:href", "data", "background"]);
// Elements whose body is not markup: a <script> or <style> body is code the page runs; the others are text the
// page only shows (a <noscript> body too, since scripts run in the frame).
const RAW_TEXT_ELEMENTS = new Set([
	"script",
	"style",
	"textarea",
	"title",
	"xmp",
	"noscript",
	"iframe",
	"noembed",
	"noframes",
	"plaintext",
]);
const TAG_START = /<\/?([a-z][^\s/>]*)/iy;
const SPACE = /[\t\n\f\r ]/;
const ATTRIBUTE_NAME_END = /[\t\n\f\r />=]/;
const UNQUOTED_VALUE_END = /[\t\n\f\r >]/;

export interface ImageReference {
	readonly start: number;
	readonly end: number;
	readonly path: string;
}

interface Attribute {
	readonly name: string;
	/** The value's span; empty for an attribute without a value. */
	readonly start: number;
	readonly end: number;
}

const skipSpace = (html: string, from: number) => {
	let at = from;
	while (SPACE.test(html.charAt(at))) at += 1;
	return at;
};

const endAfter = (html: string, token: string, from: number) => {
	const at = html.indexOf(token, from);
	return at === -1 ? html.length : at + token.length;
};

/** Where a comment whose body starts at `from` ends: `<!-->` and `<!--->` end at once. */
const commentEnd = (html: string, from: number) => {
	if (html.startsWith(">", from)) return from + 1;
	if (html.startsWith("->", from)) return from + 2;
	return endAfter(html, "-->", from);
};

/**
 * The attributes of the tag whose attribute list starts at `from`, and where the tag ends; undefined when the page
 * ends inside it, as a browser then drops the tag. A quote starts a value only right after `=`, and only the first
 * of a repeated attribute name counts.
 */
const readTag = (html: string, from: number): { attributes: Attribute[]; end: number } | undefined => {
	const attributes: Attribute[] = [];
	const names = new Set<string>();
	const add = (attribute: Attribute) => {
		if (names.has(attribute.name)) return;
		names.add(attribute.name);
		attributes.push(attribute);
	};
	let at = from;
	while (at < html.length) {
		const char = html.charAt(at);
		if (char === ">") return { attributes, end: at + 1 };
		if (char === "/" || SPACE.test(char)) {
			at += 1;
			continue;
		}
		// The first character belongs to the name even when it is "=".
		const nameStart = at;
		at += 1;
		while (at < html.length && !ATTRIBUTE_NAME_END.test(html.charAt(at))) at += 1;
		const name = html.slice(nameStart, at).toLowerCase();
		const equals = skipSpace(html, at);
		if (html.charAt(equals) !== "=") {
			add({ name, start: at, end: at });
			at = equals;
			continue;
		}
		const value = skipSpace(html, equals + 1);
		const quote = html.charAt(value);
		if (quote === '"' || quote === "'") {
			const close = html.indexOf(quote, value + 1);
			if (close === -1) return undefined;
			add({ name, start: value + 1, end: close });
			at = close + 1;
			continue;
		}
		at = value;
		while (at < html.length && !UNQUOTED_VALUE_END.test(html.charAt(at))) at += 1;
		add({ name, start: value, end: at });
	}
	return undefined;
};

/** The span `start`-`end` as a reference when, without surrounding spaces, it is an absolute image path. */
const pathAt = (html: string, start: number, end: number): ImageReference[] => {
	let from = start;
	let to = end;
	while (from < to && SPACE.test(html.charAt(from))) from += 1;
	while (to > from && SPACE.test(html.charAt(to - 1))) to -= 1;
	const path = html.slice(from, to);
	return IMAGE_PATH.test(path) ? [{ start: from, end: to, path }] : [];
};

/** The candidate URLs of a srcset value: each is a run of non-spaces, trailing commas dropped, then descriptors. */
const srcsetReferences = (html: string, start: number, end: number): ImageReference[] => {
	const references: ImageReference[] = [];
	let at = start;
	while (at < end) {
		while (at < end && (SPACE.test(html.charAt(at)) || html.charAt(at) === ",")) at += 1;
		let urlEnd = at;
		while (urlEnd < end && !SPACE.test(html.charAt(urlEnd))) urlEnd += 1;
		let trimmed = urlEnd;
		while (trimmed > at && html.charAt(trimmed - 1) === ",") trimmed -= 1;
		references.push(...pathAt(html, at, trimmed));
		const comma = trimmed < urlEnd ? urlEnd - 1 : html.indexOf(",", urlEnd);
		at = comma === -1 || comma >= end ? end : comma + 1;
	}
	return references;
};

const matches = (pattern: RegExp, html: string, start: number, end: number): ImageReference[] => {
	const body = html.slice(start, end);
	const references: ImageReference[] = [];
	for (const match of body.matchAll(pattern)) {
		const span = match.indices?.[2] ?? match.indices?.[3];
		if (span) references.push({ start: start + span[0], end: start + span[1], path: body.slice(span[0], span[1]) });
	}
	return references;
};

const attributeReferences = (html: string, { name, start, end }: Attribute): ImageReference[] => {
	if (URL_ATTRIBUTES.has(name)) return pathAt(html, start, end);
	if (name === "srcset") return srcsetReferences(html, start, end);
	if (name === "style") return matches(CSS_URL, html, start, end);
	if (name.startsWith("on")) return matches(SCRIPT_PATH, html, start, end);
	return [];
};

/** Where the raw text body of `element` that starts at `from` ends: at its end tag, or at the end of the page. */
const rawTextEnd = (lower: string, element: string, from: number) => {
	const token = `</${element}`;
	for (let at = lower.indexOf(token, from); at !== -1; at = lower.indexOf(token, at + 1)) {
		if (/[\t\n\f\r />]/.test(lower.charAt(at + token.length))) return at;
	}
	return lower.length;
};

/** The absolute image paths the page loads, in page order. */
export function findLocalImages(html: string): ImageReference[] {
	const references: ImageReference[] = [];
	const lower = html.toLowerCase();
	// Inside <svg> or <math> a CDATA section is text up to "]]>"; elsewhere "<![CDATA[" opens a bogus comment.
	let foreignDepth = 0;
	let at = 0;
	while (at < html.length) {
		const open = html.indexOf("<", at);
		if (open === -1) break;
		const next = html.charAt(open + 1);
		if (html.startsWith("<!--", open)) {
			at = commentEnd(html, open + 4);
			continue;
		}
		if (foreignDepth > 0 && html.startsWith("<![CDATA[", open)) {
			at = endAfter(html, "]]>", open + 9);
			continue;
		}
		if (next === "!" || next === "?" || (next === "/" && !/[a-z]/i.test(html.charAt(open + 2)))) {
			at = endAfter(html, ">", open + 2);
			continue;
		}
		TAG_START.lastIndex = open;
		const name = TAG_START.exec(html);
		if (!name) {
			at = open + 1;
			continue;
		}
		const tag = readTag(html, TAG_START.lastIndex);
		if (!tag) break;
		at = tag.end;
		const element = name[1]?.toLowerCase() ?? "";
		const closing = next === "/";
		if (element === "svg" || element === "math") {
			if (closing) foreignDepth = Math.max(0, foreignDepth - 1);
			else if (html.charAt(tag.end - 2) !== "/") foreignDepth += 1;
		}
		if (closing) continue;
		for (const attribute of tag.attributes) references.push(...attributeReferences(html, attribute));
		if (!RAW_TEXT_ELEMENTS.has(element)) continue;
		const bodyEnd = element === "plaintext" ? html.length : rawTextEnd(lower, element, at);
		if (element === "script") references.push(...matches(SCRIPT_PATH, html, at, bodyEnd));
		else if (element === "style") references.push(...matches(CSS_URL, html, at, bodyEnd));
		at = bodyEnd;
	}
	return references;
}
