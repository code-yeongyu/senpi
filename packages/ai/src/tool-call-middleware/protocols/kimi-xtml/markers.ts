export const XTML_TOOLS_OPEN = "<|open|>tools<|sep|>";
export const XTML_TOOLS_CLOSE = "<|close|>tools<|sep|>";
export const XTML_CALL_OPEN = "<|open|>call ";
export const XTML_CALL_CLOSE = "<|close|>call<|sep|>";
export const XTML_ARGUMENT_OPEN = "<|open|>argument ";
export const XTML_ARGUMENT_CLOSE = "<|close|>argument<|sep|>";
export const XTML_SEP = "<|sep|>";

export const XTML_OPEN_PREFIX = "<|open|>";
export const XTML_CLOSE_PREFIX = "<|close|>";

const CHANNEL_NAME = "[a-zA-Z_][a-zA-Z0-9_]*";
const STRUCTURAL_CHANNEL_NAME = "(?:call|argument)\\b";
const SEPLESS_CHANNEL_NAME = `(?!${STRUCTURAL_CHANNEL_NAME})${CHANNEL_NAME}`;

export const XTML_CHANNEL_MARKER_PATTERN = new RegExp(
	[
		`<\\|(?:open|close)\\|>(?:${CHANNEL_NAME})?<\\|sep\\|>`,
		`<\\|(?:open|close)\\|>(?:${SEPLESS_CHANNEL_NAME})?(?=$|[^a-zA-Z0-9_])`,
		`<\\|sep\\|>`,
	].join("|"),
	"g",
);

const ANCHORED_CHANNEL_MARKER_PATTERN = new RegExp(`^(?:${XTML_CHANNEL_MARKER_PATTERN.source})`);

export function matchXtmlChannelMarker(text: string): string | undefined {
	return ANCHORED_CHANNEL_MARKER_PATTERN.exec(text)?.[0];
}

const ATTRIBUTE_PATTERN = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<]+))/g;

export function parseXtmlAttributes(header: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of header.matchAll(ATTRIBUTE_PATTERN)) {
		const key = match[1];
		if (!key) continue;
		attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
	}
	return attributes;
}

export function getPartialXtmlSuffix(text: string, tokens: readonly string[]): string {
	for (const token of tokens) {
		for (let length = token.length - 1; length > 0; length -= 1) {
			const prefix = token.slice(0, length);
			if (text.endsWith(prefix)) {
				return prefix;
			}
		}
	}
	return "";
}
