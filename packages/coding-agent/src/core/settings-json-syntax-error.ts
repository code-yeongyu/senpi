/** A settings file that is not valid JSON(C), with the 1-based position where parsing stopped. */
export class SettingsJsonSyntaxError extends SyntaxError {
	readonly line: number;
	readonly column: number;

	constructor(message: string, line: number, column: number) {
		super(message);
		this.name = "SyntaxError";
		this.line = line;
		this.column = column;
	}
}

/** Build the error for `text` stopping at `offset`; `text` must keep the source's line breaks. */
export function settingsSyntaxErrorAt(text: string, offset: number, message: string): SettingsJsonSyntaxError {
	const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
	return new SettingsJsonSyntaxError(message, lines.length, (lines.at(-1) ?? "").length + 1);
}

class StopAt {
	readonly offset: number;
	constructor(offset: number) {
		this.offset = offset;
	}
}

/**
 * Offset of the first character where strict JSON `text` stops parsing (its length when the text is
 * truncated). `JSON.parse` only reports a position on V8; Bun's engine names no position at all.
 */
export function jsonSyntaxErrorOffset(text: string): number | undefined {
	let index = 0;
	const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
	const stop = (): never => {
		throw new StopAt(Math.min(index, text.length));
	};
	const skipWhitespace = (): void => {
		while (index < text.length && " \t\n\r".includes(text.charAt(index))) index += 1;
	};
	const literal = (word: string): void => {
		for (const char of word) {
			if (text.charAt(index) !== char) stop();
			index += 1;
		}
	};
	const string = (): void => {
		index += 1;
		while (index < text.length) {
			const char = text.charAt(index);
			if (char === '"') {
				index += 1;
				return;
			}
			if (char < " ") stop();
			index += char === "\\" ? 2 : 1;
		}
		stop();
	};
	const number = (): void => {
		numberPattern.lastIndex = index;
		if (numberPattern.exec(text) === null) stop();
		index = numberPattern.lastIndex;
	};
	const container = (close: "}" | "]"): void => {
		index += 1;
		skipWhitespace();
		if (text.charAt(index) === close) {
			index += 1;
			return;
		}
		for (;;) {
			if (close === "}") {
				skipWhitespace();
				if (text.charAt(index) !== '"') stop();
				string();
				skipWhitespace();
				if (text.charAt(index) !== ":") stop();
				index += 1;
			}
			value();
			skipWhitespace();
			const next = text.charAt(index);
			index += 1;
			if (next === close) return;
			if (next !== ",") {
				index -= 1;
				stop();
			}
		}
	};
	const value = (): void => {
		skipWhitespace();
		const char = text.charAt(index);
		if (char === "{") container("}");
		else if (char === "[") container("]");
		else if (char === '"') string();
		else if (char === "t") literal("true");
		else if (char === "f") literal("false");
		else if (char === "n") literal("null");
		else if (char === "-" || (char >= "0" && char <= "9")) number();
		else stop();
	};
	try {
		value();
		skipWhitespace();
		if (index < text.length) stop();
		return undefined;
	} catch (error) {
		if (error instanceof StopAt) return error.offset;
		throw error;
	}
}
