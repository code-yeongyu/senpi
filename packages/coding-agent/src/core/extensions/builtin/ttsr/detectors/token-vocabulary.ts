/** Characters and names that make up a control-token candidate; the parser that reads them is token-grammar.ts. */
export const LESS_THAN = "<";
export const GREATER_THAN = ">";
export const PIPE = "|";
/** DeepSeek special tokens delimit their names with a fullwidth bar: `<｜end▁of▁sentence｜>` (senpi#4621). */
const FULLWIDTH_PIPE = "\uFF5C";
/** SentencePiece word-boundary mark inside DeepSeek token names. */
export const SPACE_MARK = "\u2581";
/** DeepSeek's tool-call markup: `<｜DSML｜invoke name="...">`, `</｜DSML｜parameter>`. */
export const DSML_NAME = "DSML";
export const SLASH = "/";
export const LEFT_BRACKET = "[";
export const RIGHT_BRACKET = "]";
const UNDERSCORE = "_";

export function isAsciiUpper(value: string): boolean {
	const code = value.charCodeAt(0);
	return code >= 65 && code <= 90;
}

function isAsciiLower(value: string): boolean {
	const code = value.charCodeAt(0);
	return code >= 97 && code <= 122;
}

function isAsciiDigit(value: string): boolean {
	const code = value.charCodeAt(0);
	return code >= 48 && code <= 57;
}

export function isAsciiLetter(value: string): boolean {
	return isAsciiUpper(value) || isAsciiLower(value);
}

export function isNameChar(value: string): boolean {
	return isAsciiLetter(value) || isAsciiDigit(value) || value === UNDERSCORE;
}

export function isBar(value: string): boolean {
	return value === PIPE || value === FULLWIDTH_PIPE;
}

/**
 * Angle-bracket special tokens that tokenizers actually define (SentencePiece/Llama `<s>`,
 * BERT-style `<pad>`/`<unk>`/`<mask>`, Gemma turn markers, reasoning and tool-call delimiters).
 * Matched case-insensitively, with or without the closing slash. Anything else in angle
 * brackets is markup, not a control token.
 */
export const SGML_CONTROL_TOKEN_NAMES: ReadonlySet<string> = new Set([
	"s",
	"pad",
	"unk",
	"mask",
	"bos",
	"eos",
	"sep",
	"cls",
	"eot",
	"eom",
	"endoftext",
	"think",
	"start_of_turn",
	"end_of_turn",
	"start_of_image",
	"end_of_image",
	"im_start",
	"im_end",
	"tool_call",
	"tool_response",
]);

export function isSgmlControlTokenName(rawName: string): boolean {
	const name = rawName.startsWith(SLASH) ? rawName.slice(1) : rawName;
	return SGML_CONTROL_TOKEN_NAMES.has(name.toLowerCase());
}

export function isBracketNameChar(value: string): boolean {
	return isAsciiUpper(value) || isAsciiDigit(value) || value === UNDERSCORE;
}
