import type { Scan } from "./brace-scanner.ts";
import { stringSpan } from "./lexical-spans.ts";
import type { Fold } from "./scorer.ts";

type Statement = { readonly first: number; readonly last: number; readonly indent: number; readonly code: string };

// Token/indent screening, not an external Python interpreter or parser. String
// contents are opaque; balanced continuations form one logical statement.
export function scanPython(source: string): Scan {
	const statements: Statement[] = [];
	const brackets: ("(" | "[" | "{")[] = [];
	const levels = [0];
	const fail = (fallbackReason: string): Scan => ({ ranges: [], fallbackReason });
	let i = 0;
	let line = 1;
	let first = 1;
	let indent = 0;
	let column = 0;
	let code = "";
	let lineStart = true;
	let indentationError = false;
	const flush = () => {
		if (!code.trim()) {
			code = "";
			return;
		}
		const previous = statements[statements.length - 1];
		const opensSuite = previous?.code.trimEnd().endsWith(":") ?? false;
		if (indent > levels[levels.length - 1]) {
			if (!opensSuite) indentationError = true;
			levels.push(indent);
		} else {
			if (opensSuite) indentationError = true;
			while (levels.length > 1 && indent < levels[levels.length - 1]) levels.pop();
			if (indent !== levels[levels.length - 1]) indentationError = true;
		}
		statements.push({ first, last: line, indent, code: code.trim() });
		code = "";
	};
	while (i < source.length) {
		const char = source[i];
		if (char === "\n") {
			if (!brackets.length) flush();
			else code += " ";
			line++;
			column = 0;
			lineStart = true;
			i++;
			continue;
		}
		if (char === "\r") {
			i++;
			continue;
		}
		if (lineStart && (char === " " || char === "\t")) {
			if (char === "\t") return fail("python_mixed_indentation");
			column++;
			i++;
			continue;
		}
		if (char === "#") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (!code.trim() && char !== " ") {
			first = line;
			indent = column;
		}
		lineStart = false;
		if (char === "\\") {
			if (source[i + 1] !== "\n") return fail("python_invalid_continuation");
			line++;
			column = 0;
			lineStart = true;
			code += " ";
			i += 2;
			continue;
		}
		if (char === '"' || char === "'") {
			const triple = source.startsWith(char.repeat(3), i);
			const delimiter = triple ? char.repeat(3) : char;
			const span = stringSpan(source, i + delimiter.length, { delimiter, multiline: triple });
			if (!span) return fail("python_unterminated_string");
			code += " STRING ";
			line += span.newlines;
			i = span.end;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") brackets.push(char);
		if (char === ")" || char === "]" || char === "}") {
			const open = brackets.pop();
			if (!open || { "(": ")", "[": "]", "{": "}" }[open] !== char) return fail("python_unbalanced_delimiters");
		}
		code += char;
		i++;
	}
	flush();
	if (brackets.length) return fail("python_unbalanced_delimiters");
	if (indentationError || statements[statements.length - 1]?.code.endsWith(":"))
		return fail("python_invalid_indentation");
	const ranges: Fold[] = [];
	for (let n = 0; n < statements.length; n++) {
		const header = statements[n];
		// Multiline signatures must remain intact. The frozen oracle only
		// authorizes header.first+1, so these particular ranges stay unfolded.
		if (header.first !== header.last || !/^(?:async\s+)?def\s+\w+\s*\(.*\).*:\s*$/.test(header.code)) continue;
		let next = n + 1;
		while (next < statements.length && statements[next].indent > header.indent) next++;
		if (next === n + 1) return fail("python_empty_suite");
		const end = statements[next - 1].last - 1;
		if (end - header.first >= 4) ranges.push({ start: header.first + 1, end });
	}
	return { ranges };
}
