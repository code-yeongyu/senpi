export type Span = { readonly end: number; readonly newlines: number };

// The caller has consumed the opener. All offsets are UTF-16 indices into the
// original string; only whole source lines are eventually folded.
export function stringSpan(
	source: string,
	start: number,
	options: { readonly delimiter: string; readonly multiline: boolean; readonly raw?: boolean },
): Span | undefined {
	let newlines = 0;
	for (let i = start; i < source.length; i++) {
		if (source.startsWith(options.delimiter, i)) return { end: i + options.delimiter.length, newlines };
		if (source[i] === "\n") {
			if (!options.multiline) return undefined;
			newlines++;
		}
		if (source[i] === "\\" && !options.raw) {
			if (source[i + 1] === "\n") newlines++;
			i++;
		}
	}
	return undefined;
}

export function commentSpan(source: string, start: number, nested: boolean): Span | undefined {
	let depth = 1;
	let newlines = 0;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "\n") newlines++;
		if (nested && source.startsWith("/*", i)) {
			depth++;
			i++;
		} else if (source.startsWith("*/", i)) {
			if (--depth === 0) return { end: i + 2, newlines };
			i++;
		}
	}
	return undefined;
}

export function regexSpan(source: string, start: number): Span | undefined {
	let characterClass = false;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "\n" || source[i] === "\r") return undefined;
		if (source[i] === "\\") {
			i++;
			continue;
		}
		if (source[i] === "[") characterClass = true;
		if (source[i] === "]") characterClass = false;
		if (source[i] === "/" && !characterClass) {
			let end = i + 1;
			while (/[a-z]/i.test(source[end] ?? "")) end++;
			return { end, newlines: 0 };
		}
	}
	return undefined;
}
