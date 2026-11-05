import {
	DSML_NAME,
	GREATER_THAN,
	isAsciiLetter,
	isAsciiUpper,
	isBar,
	isBracketNameChar,
	isNameChar,
	isSgmlControlTokenName,
	LEFT_BRACKET,
	LESS_THAN,
	PIPE,
	RIGHT_BRACKET,
	SLASH,
	SPACE_MARK,
} from "./token-vocabulary.ts";

export type TokenFamily = "ctrl" | "sgml" | "bracket" | "dsml";

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
	| "bracketName"
	| "dsmlTag";

const MAX_CTRL_NAME = 32;
const MAX_SGML_NAME = 16;
const MAX_BRACKET_NAME = 16;
const MIN_BRACKET_NAME = 2;
const MAX_DSML_TAG = 512;

export class CandidateParser {
	#mode: ParserMode = "ground";
	#buffer = "";
	#nameLength = 0;
	#startOffset = 0;
	#bar = PIPE;
	#closing = false;

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
		this.#bar = PIPE;
		this.#closing = false;
	}

	#ctrlName(): string {
		return this.#buffer.slice(this.#closing ? 3 : 2, -1);
	}

	#advance(value: string, offset: number): CandidateOutcome[] {
		const mode = this.#mode;
		if (mode === "angleOpen") {
			if (isBar(value)) {
				this.#buffer += value;
				this.#bar = value;
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
			if (value === this.#bar) {
				this.#buffer += value;
				this.#mode = "ctrlClose";
				return [];
			}
			if (isNameChar(value) || value === SPACE_MARK) {
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
			const isDsml = this.#ctrlName() === DSML_NAME;
			if (value === GREATER_THAN) {
				if (isDsml) return [this.#emitToken("dsml", DSML_NAME, value, offset)];
				if (this.#closing) return this.#rejectWith(value, offset);
				return [this.#emitToken("ctrl", this.#ctrlName(), value, offset)];
			}
			if (isDsml && value !== LESS_THAN) {
				this.#buffer += value;
				this.#mode = "dsmlTag";
				return [];
			}
			return this.#rejectWith(value, offset);
		}
		if (mode === "dsmlTag") {
			if (value === GREATER_THAN) return [this.#emitToken("dsml", DSML_NAME, value, offset)];
			if (value === LESS_THAN || this.#buffer.length >= MAX_DSML_TAG) return this.#rejectWith(value, offset);
			this.#buffer += value;
			return [];
		}
		if (mode === "sgmlFirst") {
			if (isBar(value)) {
				this.#buffer += value;
				this.#bar = value;
				this.#closing = true;
				this.#mode = "ctrlFirst";
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
		return this.#emitToken(
			family,
			this.#buffer.slice(nameStart, nameTrimEnd === 0 ? undefined : nameTrimEnd),
			closer,
			offset,
		);
	}

	#emitToken(family: TokenFamily, name: string, closer: string, offset: number): CandidateOutcome {
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
		this.#bar = PIPE;
		this.#closing = false;
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
