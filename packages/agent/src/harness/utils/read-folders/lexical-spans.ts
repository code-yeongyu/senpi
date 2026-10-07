type Span = { readonly end: number; readonly newlines: number };

// Selected TS/JS/JSON branches of row 17's measured literal scanner.
// Offsets are UTF-16 indices; output coordinates always describe whole source lines.
export function stringSpan(source: string, start: number, delimiter: string): Span | undefined {
	let newlines = 0;
	for (let i = start; i < source.length; i++) {
		if (source[i] === delimiter) return { end: i + 1, newlines };
		if (source[i] === "\n" || source[i] === "\r") return undefined;
		if (source[i] === "\\") {
			if (source[i + 1] === "\r" && source[i + 2] === "\n") i++;
			if (source[i + 1] === "\n") newlines++;
			i++;
		}
	}
	return undefined;
}

/** Skip only brace-free type arguments; constraints/object types still take the protected/raw path. */
export function typeArgumentsSpan(source: string, start: number): Span | undefined {
	const delimiters = ["<"];
	let newlines = 0;
	for (let i = start; i < source.length; i++) {
		const char = source[i];
		if (char === "\n") newlines++;
		if (char === '"' || char === "'") {
			const span = stringSpan(source, i + 1, char);
			if (!span) return undefined;
			newlines += span.newlines;
			i = span.end - 1;
		} else if (char === "<" || char === "[") delimiters.push(char);
		else if (char === ">" || char === "]") {
			if (delimiters.pop() !== (char === ">" ? "<" : "[")) return undefined;
			if (!delimiters.length) return { end: i + 1, newlines };
		} else if (!/[A-Za-z_$0-9\s,.?|&]/.test(char)) return undefined;
	}
	return undefined;
}

export function lineCommentEnd(source: string, start: number): number {
	let end = start;
	while (end < source.length && !/[\n\r\u2028\u2029]/.test(source[end])) end++;
	return end;
}

export function commentSpan(source: string, start: number): Span | undefined {
	let newlines = 0;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "\n") newlines++;
		if (source.startsWith("*/", i)) return { end: i + 2, newlines };
	}
	return undefined;
}

export function regexSpan(source: string, start: number): Span | undefined {
	let characterClass = false;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "\n" || source[i] === "\r" || source[i] === "\u2028" || source[i] === "\u2029")
			return undefined;
		if (source[i] === "\\") {
			if (/[\r\n\u2028\u2029]/.test(source[i + 1] ?? "")) return undefined;
			i++;
			continue;
		}
		if (source[i] === "[") characterClass = true;
		if (source[i] === "]") characterClass = false;
		if (source[i] === "/" && !characterClass) {
			let end = i + 1;
			while (/[a-z]/i.test(source[end] ?? "")) end++;
			const flags = source.slice(i + 1, end);
			// Unicode-set regexes need a different nested-class grammar; do not guess.
			if (/[^dgimsuy]/.test(flags) || new Set(flags).size !== flags.length) return undefined;
			return { end, newlines: 0 };
		}
	}
	return undefined;
}
