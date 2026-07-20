const WHITESPACE = /\s/;
const INVOKE_OPEN_TAG = /^<\s*invoke\b[^>]*>$/;
const INVOKE_CLOSE_TAG = /^<\s*\/\s*invoke\s*>$/;
const PARAMETER_OPEN_TAG = /^<\s*parameter\b[^>]*>$/;
const PARAMETER_CLOSE_TAG = /^<\s*\/\s*parameter\s*>$/;

/** Incomplete protocol fragments are rejected before retained input can exceed this many UTF-16 code units. */
export const ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH = 64 * 1024;

export type StreamBoundaryMatcher = {
	feed(text: string): boolean;
};

export type PendingFragment = {
	readonly kind: "invoke" | "function-calls" | "open-tag";
	readonly matcher: StreamBoundaryMatcher;
};

type ClosingTagState = "seek" | "after-open" | "after-slash" | "name" | "after-name";

function isWhitespace(character: string): boolean {
	return WHITESPACE.test(character);
}

function createInvokeBoundaryMatcher(): StreamBoundaryMatcher {
	let invokeDepth = 0;
	const parameterInvokeDepths: number[] = [];
	let tagCharacters: string[] | null = null;

	return {
		feed(text: string): boolean {
			for (const character of text) {
				if (tagCharacters === null) {
					if (character === "<") {
						tagCharacters = [character];
					}
					continue;
				}

				if (character === "<") {
					tagCharacters = [character];
					continue;
				}
				tagCharacters.push(character);
				if (character !== ">") {
					continue;
				}

				const tag = tagCharacters.join("");
				tagCharacters = null;
				if (INVOKE_OPEN_TAG.test(tag)) {
					invokeDepth += 1;
					continue;
				}
				if (PARAMETER_OPEN_TAG.test(tag)) {
					parameterInvokeDepths.push(invokeDepth);
					continue;
				}
				if (PARAMETER_CLOSE_TAG.test(tag)) {
					const parameterInvokeDepth = parameterInvokeDepths.pop();
					if (parameterInvokeDepth !== undefined && invokeDepth > parameterInvokeDepth) {
						invokeDepth = parameterInvokeDepth;
					}
					continue;
				}
				if (!INVOKE_CLOSE_TAG.test(tag) || invokeDepth === 0) {
					continue;
				}

				invokeDepth -= 1;
				while (parameterInvokeDepths.length > 0) {
					const parameterInvokeDepth = parameterInvokeDepths[parameterInvokeDepths.length - 1];
					if (parameterInvokeDepth === undefined || parameterInvokeDepth <= invokeDepth) {
						break;
					}
					parameterInvokeDepths.pop();
				}
				if (invokeDepth === 0) {
					return true;
				}
			}
			return false;
		},
	};
}

export function createClosingTagMatcher(tagName: "invoke" | "function_calls"): StreamBoundaryMatcher {
	let state: ClosingTagState = "seek";
	let nameIndex = 0;

	function restart(character: string): void {
		state = character === "<" ? "after-open" : "seek";
		nameIndex = 0;
	}

	return {
		feed(text: string): boolean {
			let matched = false;
			for (const character of text) {
				switch (state) {
					case "seek":
						if (character === "<") {
							state = "after-open";
						}
						break;
					case "after-open":
						if (character === "/") {
							state = "after-slash";
						} else if (!isWhitespace(character)) {
							restart(character);
						}
						break;
					case "after-slash":
						if (character === tagName[0]) {
							nameIndex = 1;
							state = "name";
						} else if (!isWhitespace(character)) {
							restart(character);
						}
						break;
					case "name":
						if (character !== tagName[nameIndex]) {
							restart(character);
							break;
						}
						nameIndex += 1;
						if (nameIndex === tagName.length) {
							state = "after-name";
						}
						break;
					case "after-name":
						if (character === ">") {
							matched = true;
							state = "seek";
							nameIndex = 0;
						} else if (!isWhitespace(character)) {
							restart(character);
						}
						break;
				}
			}
			return matched;
		},
	};
}

export function createTagEndMatcher(): StreamBoundaryMatcher {
	return {
		feed(text: string): boolean {
			return text.includes(">");
		},
	};
}

export function createPendingFragment(kind: PendingFragment["kind"], text: string): PendingFragment {
	const matcher =
		kind === "invoke"
			? createInvokeBoundaryMatcher()
			: kind === "function-calls"
				? createClosingTagMatcher("function_calls")
				: createTagEndMatcher();
	matcher.feed(text);
	return { kind, matcher };
}
