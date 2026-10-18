import { stripBom } from "../utils/text.ts";

/** Parse JSON or JSONC without changing comment-like text inside strings. */
export function parseSettingsJson(content: string): Record<string, unknown> {
	content = stripBom(content);
	const withoutComments: string[] = [];
	let inString = false;
	let escaped = false;

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		const next = content[index + 1];
		if (inString) {
			withoutComments.push(char);
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			withoutComments.push(char);
			continue;
		}
		if (char === "/" && next === "/") {
			withoutComments.push(" ", " ");
			index += 2;
			while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
				withoutComments.push(" ");
				index += 1;
			}
			if (index < content.length) withoutComments.push(content[index]);
			continue;
		}
		if (char === "/" && next === "*") {
			withoutComments.push(" ", " ");
			index += 2;
			let closed = false;
			for (; index < content.length; index += 1) {
				if (content[index] === "*" && content[index + 1] === "/") {
					withoutComments.push(" ", " ");
					index += 1;
					closed = true;
					break;
				}
				withoutComments.push(content[index] === "\n" || content[index] === "\r" ? content[index] : " ");
			}
			if (!closed) throw new SyntaxError("Unterminated block comment in settings");
			continue;
		}
		withoutComments.push(char);
	}

	const normalized = withoutComments;
	inString = false;
	escaped = false;
	for (let index = 0; index < normalized.length; index += 1) {
		const char = normalized[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char !== ",") continue;
		let nextIndex = index + 1;
		while (nextIndex < normalized.length && /\s/.test(normalized[nextIndex])) nextIndex += 1;
		if (normalized[nextIndex] === "}" || normalized[nextIndex] === "]") normalized[index] = " ";
	}

	const parsed: unknown = JSON.parse(normalized.join(""));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError("Settings must contain a JSON object");
	}
	return parsed as Record<string, unknown>;
}
