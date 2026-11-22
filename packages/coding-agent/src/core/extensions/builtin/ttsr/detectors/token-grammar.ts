export type TokenFamily = "ctrl" | "sgml" | "bracket";

export interface ControlToken {
	readonly family: TokenFamily;
	readonly name: string;
	readonly tokenId: string;
	readonly text: string;
	readonly startOffset: number;
	readonly endOffset: number;
}

export type CandidateOutcome =
	| { readonly kind: "ground"; readonly value: string; readonly offset: number }
	| { readonly kind: "token"; readonly token: ControlToken }
	| { readonly kind: "reject"; readonly text: string; readonly startOffset: number };

type ParserMode =
	| "ground"
	| "angleOpen"
	| "ctrlFirst"
	| "ctrlName"
	| "ctrlClose"
	| "sgmlFirst"
	| "sgmlName"
	| "bracketFirst"
	| "bracketName";

const MAX_CTRL_NAME = 32;
const MAX_SGML_NAME = 16;
const MAX_BRACKET_NAME = 16;
const MIN_BRACKET_NAME = 2;

const LESS_THAN = "<";
const GREATER_THAN = ">";
const PIPE = "|";
const SLASH = "/";
const LEFT_BRACKET = "[";
const RIGHT_BRACKET = "]";
const UNDERSCORE = "_";

function isAsciiUpper(value: string): boolean {
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

function isAsciiLetter(value: string): boolean {
	return isAsciiUpper(value) || isAsciiLower(value);
}

function isNameChar(value: string): boolean {
	return isAsciiLetter(value) || isAsciiDigit(value) || value === UNDERSCORE;
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

function isBracketNameChar(value: string): boolean {
	return isAsciiUpper(value) || isAsciiDigit(value) || value === UNDERSCORE;
}

export class CandidateParser {
	#mode: ParserMode = "ground";
	#buffer = "";
	#nameLength = 0;
	#startOffset = 0;

	feed(value: string, offset: number): CandidateOutcome[] {
		if (this.#mode === "ground") {
			if (value === LESS_THAN) {
				this.#begin("angleOpen", value, offset);
				return [];
			}
			if (value === LEFT_BRACKET) {
				this.#begin("bracketFirst", value, offset);
				return [];
			}
			return [{ kind: "ground", value, offset }];
		}
		return this.#advance(value, offset);
	}

	get pendingLength(): number {
		return this.#mode === "ground" ? 0 : this.#buffer.length;
	}

	#begin(mode: ParserMode, value: string, offset: number): void {
		this.#mode = mode;
		this.#buffer = value;
		this.#nameLength = 0;
		this.#startOffset = offset;
	}

	#advance(value: string, offset: number): CandidateOutcome[] {
		const mode = this.#mode;
		if (mode === "angleOpen") {
			if (value === PIPE) {
				this.#buffer += value;
				this.#mode = "ctrlFirst";
				return [];
			}
			if (value === SLASH) {
				this.#buffer += value;
				this.#mode = "sgmlFirst";
				return [];
			}
			if (isAsciiLetter(value)) {
				this.#buffer += value;
				this.#nameLength = 1;
				this.#mode = "sgmlName";
				return [];
			}
			return this.#rejectWith(value, offset);
		}
		if (mode === "ctrlFirst") {
			if (isAsciiLetter(value)) {
				this.#buffer += value;
				this.#nameLength = 1;
				this.#mode = "ctrlName";
				return [];
			}
			return this.#rejectWith(value, offset);
		}
		if (mode === "ctrlName") {
			if (value === PIPE) {
				this.#buffer += value;
				this.#mode = "ctrlClose";
				return [];
			}
			if (isNameChar(value)) {
				if (this.#nameLength >= MAX_CTRL_NAME) {
					return this.#rejectWith(value, offset);
				}
				this.#buffer += value;
				this.#nameLength += 1;
				return [];
			}
			return this.#rejectWith(value, offset);
		}
		if (mode === "ctrlClose") {
			if (value === GREATER_THAN) {
				return [this.#emit("ctrl", 2, -1, value, offset)];
			}
			return this.#rejectWith(value, offset);
		}
		if (mode === "sgmlFirst") {
			if (isAsciiLetter(value)) {
				this.#buffer += value;
				this.#nameLength = 1;
				this.#mode = "sgmlName";
				return [];
			}
			return this.#rejectWith(value, offset);
		}
		if (mode === "sgmlName") {
			if (value === GREATER_THAN) {
				// Only a tokenizer special token is a leak candidate. Ordinary markup (`</div>`, `<span>`)
				// is text: runs of HTML/XML closing tags in prose, code samples and tool arguments
				// latched the guard (omo#10789).
				if (!isSgmlControlTokenName(this.#buffer.slice(1))) {
					return this.#rejectWith(value, offset);
				}
				return [this.#emit("sgml", 1, 0, value, offset)];
			}
			if (isNameChar(value)) {
				if (this.#nameLength >= MAX_SGML_NAME) {
					return this.#rejectWith(value, offset);
				}
				this.#buffer += value;
				this.#nameLength += 1;
				return [];
			}
			return this.#rejectWith(value, offset);
		}
		if (mode === "bracketFirst") {
			if (isAsciiUpper(value)) {
				this.#buffer += value;
				this.#nameLength = 1;
				this.#mode = "bracketName";
				return [];
			}
			return this.#rejectWith(value, offset);
		}
		if (value === RIGHT_BRACKET) {
			if (this.#nameLength < MIN_BRACKET_NAME) {
				return this.#rejectWith(value, offset);
			}
			return [this.#emit("bracket", 1, 0, value, offset)];
		}
		if (isBracketNameChar(value)) {
			if (this.#nameLength >= MAX_BRACKET_NAME) {
				return this.#rejectWith(value, offset);
			}
			this.#buffer += value;
			this.#nameLength += 1;
			return [];
		}
		return this.#rejectWith(value, offset);
	}

	#emit(
		family: TokenFamily,
		nameStart: number,
		nameTrimEnd: number,
		closer: string,
		offset: number,
	): CandidateOutcome {
		const name = this.#buffer.slice(nameStart, nameTrimEnd === 0 ? undefined : nameTrimEnd);
		const token: ControlToken = {
			family,
			name,
			tokenId: `${family}:${name}`,
			text: this.#buffer + closer,
			startOffset: this.#startOffset,
			endOffset: offset + 1,
		};
		this.#mode = "ground";
		this.#buffer = "";
		this.#nameLength = 0;
		return { kind: "token", token };
	}

	#rejectWith(value: string, offset: number): CandidateOutcome[] {
		const outcomes: CandidateOutcome[] = [{ kind: "reject", text: this.#buffer, startOffset: this.#startOffset }];
		this.#mode = "ground";
		this.#buffer = "";
		this.#nameLength = 0;
		if (value === LESS_THAN) {
			this.#begin("angleOpen", value, offset);
			return outcomes;
		}
		if (value === LEFT_BRACKET) {
			this.#begin("bracketFirst", value, offset);
			return outcomes;
		}
		outcomes.push({ kind: "ground", value, offset });
		return outcomes;
	}
}
