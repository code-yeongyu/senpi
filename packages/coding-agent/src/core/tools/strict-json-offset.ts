// Where a strict JSON parse stops, for the parse-break warning (senpi#7234) on a runtime whose JSON.parse message
// carries no position. The grammar is ECMA-404, the one JSON.parse implements, so the first offset at which no valid
// JSON text can continue is the error JSON.parse reports; a text that ends early fails at its length. Worker-safe and
// linear in the text length; nesting is held in an array, not on the call stack.

const HEX_DIGIT = /^[0-9A-Fa-f]$/u;

/** `char` is one code unit, or "" past the end of the text, which matches no class. */
function isOneOf(char: string, chars: string): boolean {
	return char.length === 1 && chars.includes(char);
}

function isWhitespace(char: string): boolean {
	return isOneOf(char, " \t\n\r");
}

function isDigit(char: string): boolean {
	return char >= "0" && char <= "9";
}

/** The UTF-16 offset where strict parsing of `text` first fails, or `undefined` when it parses. */
export function strictJsonErrorOffset(text: string): number | undefined {
	let pos = 0;
	const skipWhitespace = (): void => {
		while (isWhitespace(text.charAt(pos))) pos++;
	};
	const digits = (): boolean => {
		const start = pos;
		while (isDigit(text.charAt(pos))) pos++;
		return pos > start;
	};
	const number = (): boolean => {
		if (text.charAt(pos) === "-") pos++;
		if (text.charAt(pos) === "0") pos++;
		else if (!digits()) return false;
		if (text.charAt(pos) === ".") {
			pos++;
			if (!digits()) return false;
		}
		if (text.charAt(pos) === "e" || text.charAt(pos) === "E") {
			pos++;
			if (text.charAt(pos) === "+" || text.charAt(pos) === "-") pos++;
			if (!digits()) return false;
		}
		return true;
	};
	const string = (): boolean => {
		pos++;
		for (;;) {
			const char = text.charAt(pos);
			if (char === '"') {
				pos++;
				return true;
			}
			// Control characters sort below the space, and so does "", the end of the text.
			if (char < " ") return false;
			pos++;
			if (char !== "\\") continue;
			const escape = text.charAt(pos);
			if (isOneOf(escape, '"\\/bfnrt')) {
				pos++;
				continue;
			}
			if (escape !== "u") return false;
			pos++;
			for (let digit = 0; digit < 4; digit++) {
				if (!HEX_DIGIT.test(text.charAt(pos))) return false;
				pos++;
			}
		}
	};
	const literal = (word: string): boolean => {
		for (const char of word) {
			if (text.charAt(pos) !== char) return false;
			pos++;
		}
		return true;
	};
	const scalar = (): boolean => {
		const char = text.charAt(pos);
		if (char === '"') return string();
		if (char === "-" || isDigit(char)) return number();
		if (char === "t") return literal("true");
		if (char === "f") return literal("false");
		if (char === "n") return literal("null");
		return false;
	};
	/** An object member's key and colon; the value follows. */
	const memberKey = (): boolean => {
		skipWhitespace();
		if (text.charAt(pos) !== '"' || !string()) return false;
		skipWhitespace();
		if (text.charAt(pos) !== ":") return false;
		pos++;
		return true;
	};

	const closers: string[] = [];
	for (;;) {
		// A value starts here.
		skipWhitespace();
		const open = text.charAt(pos);
		if (open === "{" || open === "[") {
			const closer = open === "{" ? "}" : "]";
			pos++;
			skipWhitespace();
			if (text.charAt(pos) === closer) {
				pos++;
			} else {
				closers.push(closer);
				if (closer === "}" && !memberKey()) return pos;
				continue;
			}
		} else if (!scalar()) {
			return pos;
		}
		// A value ended: close containers until a comma asks for the next value.
		for (;;) {
			skipWhitespace();
			const closer = closers.at(-1);
			if (closer === undefined) return pos === text.length ? undefined : pos;
			const char = text.charAt(pos);
			if (char === closer) {
				pos++;
				closers.pop();
				continue;
			}
			if (char !== ",") return pos;
			pos++;
			if (closer === "}" && !memberKey()) return pos;
			break;
		}
	}
}
