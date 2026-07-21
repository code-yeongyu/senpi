const INVOKE_OPEN_TAG = /^<\s*(?:antml:)?invoke\b[^>]*>$/;
const INVOKE_CLOSE_TAG = /^<\s*\/\s*(?:antml:)?invoke\s*>$/;
const PARAMETER_OPEN_TAG = /^<\s*(?:antml:)?parameter\b[^>]*>$/;
const PARAMETER_CLOSE_TAG = /^<\s*\/\s*(?:antml:)?parameter\s*>$/;

/** Incomplete protocol fragments are rejected before retained input can exceed this many UTF-16 code units. */
export const ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH = 64 * 1024;

export type StreamBoundaryMatcher = {
	feed(text: string): boolean;
};

export type PendingFragment = {
	readonly kind: "invoke" | "function-calls" | "open-tag";
	readonly matcher: StreamBoundaryMatcher;
};

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
	const closingTag = new RegExp(`^<\\s*\\/\\s*(?:antml:)?${tagName}\\s*>$`);
	let tagCharacters: string[] | null = null;

	return {
		feed(text: string): boolean {
			let matched = false;
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
				if (character === ">") {
					matched ||= closingTag.test(tagCharacters.join(""));
					tagCharacters = null;
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
