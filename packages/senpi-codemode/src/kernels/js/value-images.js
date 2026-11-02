import { imagePayload } from "./display-image.js";

// A value a cell returns, prints or displays as JSON becomes text, so an image inside it (a `tool.computer` or
// `tool.read` reply) would reach the model as base64 (omo#12185). projectValueImages swaps each image payload for
// a short placeholder and returns the payloads for the caller to emit as display frames. Only plain objects and
// arrays are walked; anything else is left exactly as the formatter would have shown it.
const MAX_DEPTH = 32;

export function projectValueImages(value) {
	const frames = [];
	const seen = new Map();
	const visit = (node, depth) => {
		if (typeof node !== "object" || node === null || depth >= MAX_DEPTH || !isPlainContainer(node)) return node;
		const known = seen.get(node);
		if (known !== undefined) return known;
		const image = valueImage(node);
		if (image !== undefined) {
			frames.push({ mimeType: node.mimeType, dataBase64: image.dataBase64 });
			const projected = withField(node, image.key, placeholder(node.mimeType, image.dataBase64));
			seen.set(node, projected);
			return projected;
		}
		const copy = Array.isArray(node) ? [] : {};
		seen.set(node, copy);
		let changed = false;
		for (const key of Object.keys(node)) {
			const child = node[key];
			const projected = visit(child, depth + 1);
			if (projected !== child) changed = true;
			defineField(copy, key, projected);
		}
		if (changed) return copy;
		seen.set(node, node);
		return node;
	};
	return { value: visit(value, 0), frames };
}

function isPlainContainer(node) {
	const prototype = Object.getPrototypeOf(node);
	if (!Array.isArray(node) && prototype !== Object.prototype && prototype !== null) return false;
	// Reading an accessor runs user code the formatter would not have run; leave such objects untouched.
	return Object.values(Object.getOwnPropertyDescriptors(node)).every((descriptor) => "value" in descriptor);
}

function valueImage(node) {
	if (typeof node.mimeType !== "string" || !node.mimeType.startsWith("image/")) return undefined;
	const key = typeof node.dataBase64 === "string" ? "dataBase64" : node.type === "image" && typeof node.data === "string" ? "data" : undefined;
	if (key === undefined) return undefined;
	const payload = imagePayload(node[key]);
	return payload === undefined ? undefined : { key, dataBase64: payload.dataBase64 };
}

function placeholder(mimeType, dataBase64) {
	const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
	const kilobytes = Math.max(1, Math.round(((dataBase64.length * 3) / 4 - padding) / 1024));
	return `[${mimeType} ${kilobytes} KB -> attached]`;
}

function withField(node, key, value) {
	const copy = Array.isArray(node) ? [] : {};
	for (const own of Object.keys(node)) defineField(copy, own, own === key ? value : node[own]);
	return copy;
}

// defineProperty, not assignment: an own "__proto__" key (JSON.parse makes them) must stay a plain field.
function defineField(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
