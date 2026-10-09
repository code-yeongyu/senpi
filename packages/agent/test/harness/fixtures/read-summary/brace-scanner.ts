import { commentSpan, regexSpan, stringSpan } from "./lexical-spans.ts";
import type { Fold } from "./scorer.ts";

export type Scan = { readonly ranges: readonly Fold[]; readonly fallbackReason?: string };
type Open = {
	readonly char: "{" | "[" | "(";
	readonly line: number;
	readonly foldable: boolean;
	readonly interpolation: boolean;
	readonly control: boolean;
};
const expressionKeywords = new Set([
	"return",
	"throw",
	"yield",
	"await",
	"case",
	"typeof",
	"void",
	"delete",
	"in",
	"of",
	"instanceof",
]);
const controls = new Set(["if", "while", "for", "switch", "catch", "with"]);

export function scanBraces(source: string, language: string): Scan {
	const ranges: Fold[] = [];
	const stack: Open[] = [];
	const fail = (fallbackReason: string): Scan => ({ ranges: [], fallbackReason });
	let line = 1;
	let i = 0;
	let template = false;
	let templateDepth = 0;
	let previous = "";
	let expressionEnd: boolean | null = false;
	let importClause = false;
	if (source.startsWith("#!") && !source.startsWith("#![")) {
		const end = source.indexOf("\n");
		i = end < 0 ? source.length : end;
	}
	while (i < source.length) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "\n") line++;
		if (template) {
			if (char === "\\") {
				if (next === "\n") line++;
				i += 2;
				continue;
			}
			if (char === "`") {
				template = false;
				templateDepth--;
				expressionEnd = true;
				previous = "literal";
			} else if (char === "$" && next === "{") {
				stack.push({ char: "{", line, foldable: false, interpolation: true, control: false });
				template = false;
				expressionEnd = false;
				previous = "{";
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if (char === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (char === "/" && next === "*") {
			const span = commentSpan(source, i + 2, language === "rust");
			if (!span) return fail("unterminated_comment");
			// Declaration documentation stays with its signature; ordinary block
			// comments (including body comments) remain foldable at six lines.
			if (span.newlines >= 5 && templateDepth === 0 && !source.startsWith("/**", i) && !source.startsWith("/*!", i))
				ranges.push({ start: line + 1, end: line + span.newlines - 1 });
			line += span.newlines;
			i = span.end;
			continue;
		}
		if (language === "rust" && (char === "r" || (char === "b" && next === "r"))) {
			const raw = /^(?:br|r)(#*)"/.exec(source.slice(i));
			if (raw) {
				const span = stringSpan(source, i + raw[0].length, { delimiter: `"${raw[1]}`, multiline: true, raw: true });
				if (!span) return fail("unterminated_raw_string");
				line += span.newlines;
				i = span.end;
				previous = "literal";
				expressionEnd = true;
				continue;
			}
		}
		if (language === "rust" && char === "'") {
			const lifetime = /^'[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));
			if (lifetime && source[i + lifetime[0].length] !== "'") {
				if (
					!["&", "<", ",", ":", "+", "break", "continue"].includes(previous) &&
					source[i + lifetime[0].length] !== ":"
				)
					return fail("unterminated_char_literal");
				i += lifetime[0].length;
				previous = "lifetime";
				expressionEnd = true;
				continue;
			}
		}
		if (char === '"' || char === "'") {
			const span = stringSpan(source, i + 1, { delimiter: char, multiline: language === "rust" && char === '"' });
			if (!span) return fail("unterminated_string");
			line += span.newlines;
			i = span.end;
			previous = "literal";
			expressionEnd = true;
			if (!stack.length) importClause = false;
			continue;
		}
		if (char === "`") {
			if (language === "rust" || language === "json") return fail("unexpected_backtick");
			template = true;
			templateDepth++;
			i++;
			continue;
		}
		if (char === "/") {
			if (language === "rust") {
				i += next === "=" ? 2 : 1;
				expressionEnd = false;
				previous = "/";
				continue;
			}
			if (expressionEnd === null) return fail("ambiguous_regex_literal");
			if (!expressionEnd) {
				const span = regexSpan(source, i + 1);
				if (!span) return fail("unterminated_regex_literal");
				i = span.end;
				previous = "literal";
				expressionEnd = true;
				continue;
			}
			i += next === "=" ? 2 : 1;
			expressionEnd = false;
			previous = "/";
			continue;
		}
		if (/[A-Za-z_$]/.test(char)) {
			const start = i++;
			while (/[A-Za-z_$0-9]/.test(source[i] ?? "")) i++;
			previous = source.slice(start, i);
			expressionEnd = !expressionKeywords.has(previous);
			if (previous === "import") importClause = true;
			if (previous === "from") importClause = false;
			continue;
		}
		if (/[0-9]/.test(char)) {
			i++;
			while (/[A-Za-z_0-9.]/.test(source[i] ?? "")) i++;
			expressionEnd = true;
			previous = "number";
			continue;
		}
		if (char === "{" || char === "[" || char === "(") {
			const foldable =
				templateDepth === 0 &&
				char !== "(" &&
				!importClause &&
				!["export", "type", "#", "!"].includes(previous) &&
				(char === "{" || !expressionEnd || language === "json");
			stack.push({ char, line, foldable, interpolation: false, control: char === "(" && controls.has(previous) });
			expressionEnd = false;
			previous = char;
			i++;
			continue;
		}
		if (char === "}" || char === "]" || char === ")") {
			const open = stack.pop();
			if (!open || { "{": "}", "[": "]", "(": ")" }[open.char] !== char) return fail("unbalanced_delimiters");
			if (open.interpolation) {
				template = true;
				i++;
				continue;
			}
			if (open.foldable && line - open.line - 1 >= 4) ranges.push({ start: open.line + 1, end: line - 1 });
			expressionEnd = open.control ? false : char === "}" ? null : true;
			if (char === "}") importClause = false;
			previous = char;
			i++;
			continue;
		}
		if ((char === "+" || char === "-") && next === char) {
			previous = char + char;
			i += 2;
			continue;
		}
		if (char === ";") importClause = false;
		previous = char === "=" && next === ">" ? "=>" : char;
		i += previous === "=>" ? 2 : 1;
		expressionEnd = char === "." ? null : false;
	}
	return template || templateDepth || stack.length ? fail("unbalanced_delimiters") : { ranges };
}
