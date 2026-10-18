import { HeaderProtection } from "./header-protection.ts";
import { controls, expressionKeywords, isCallCallee, type Open, signatureDeclarations } from "./lexical-context.ts";
import { commentSpan, lineCommentEnd, regexSpan, stringSpan, typeArgumentsSpan } from "./lexical-spans.ts";
import type { ReadBraceScan, ReadFoldSettings, ReadLineRange } from "./types.ts";

/** Measured row-17 brace lexer, restricted to the three selected languages. */
export function scanBraces(source: string, language: "ts" | "js" | "json", settings: ReadFoldSettings): ReadBraceScan {
	const ranges: ReadLineRange[] = [];
	const stack: Open[] = [];
	const headers = new HeaderProtection();
	const fail = (reason: string): ReadBraceScan => ({ status: "parse_failure", reason });
	let line = 1;
	let i = 0;
	let template = false;
	let templateDepth = 0;
	let previous = "";
	let beforeWord = "";
	let wordLine = 1;
	let valueArrow = false;
	let expressionEnd: boolean | null = false;
	let importClause = false;
	let ambiguousAngleDepth: number | undefined;
	let signatureDeclaration = false;
	if (source.startsWith("#!")) {
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
				stack.push({
					char: "{",
					line,
					foldable: false,
					protected: true,
					signature: false,
					interpolation: true,
					control: false,
					call: false,
					valueParameters: false,
					declaration: false,
				});
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
			i = lineCommentEnd(source, i);
			continue;
		}
		if (char === "/" && next === "*") {
			const span = commentSpan(source, i + 2);
			if (!span) return fail("unterminated_comment");
			// Keep declaration docs and every delimiter line with the source signature.
			if (
				span.newlines + 1 >= settings.minCommentLines &&
				templateDepth === 0 &&
				!stack.some((open) => open.protected) &&
				!source.startsWith("/**", i) &&
				!source.startsWith("/*!", i)
			) {
				ranges.push({ startLine: line + 1, endLine: line + span.newlines - 1 });
			}
			if (source.startsWith("/**", i) || source.startsWith("/*!", i)) headers.protect(line, line + span.newlines);
			line += span.newlines;
			i = span.end;
			continue;
		}
		if (char === '"' || char === "'") {
			const span = stringSpan(source, i + 1, char);
			if (!span) return fail("unterminated_string");
			line += span.newlines;
			i = span.end;
			previous = "literal";
			expressionEnd = true;
			if (!stack.length) importClause = false;
			continue;
		}
		if (char === "`") {
			template = true;
			templateDepth++;
			i++;
			continue;
		}
		if (char === "/") {
			if (expressionEnd === null) return fail("ambiguous_regex_literal");
			if (!expressionEnd) {
				const span = regexSpan(source, i + 1);
				if (!span) return fail("ambiguous_or_unterminated_regex");
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
			beforeWord = previous;
			previous = source.slice(start, i);
			wordLine = line;
			if (!headers.word(previous, beforeWord, stack.length, line, language === "ts")) return fail("unproved_header");
			expressionEnd = !expressionKeywords.has(previous);
			if (language === "ts" && signatureDeclarations.has(previous)) signatureDeclaration = true;
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
			if (char === "{" && ambiguousAngleDepth !== undefined) return fail("ambiguous_angle_syntax");
			if (
				language !== "json" &&
				char !== "(" &&
				previous === "," &&
				!stack.some((open) => open.protected) &&
				stack.at(-1)?.char !== "[" &&
				!stack.at(-1)?.call
			)
				return fail("ambiguous_binding");
			const classBody = headers.open(char, stack.length, previous, line);
			if (!headers.punctuation(char, stack.length, line)) return fail("unproved_header");
			const call = char === "(" && isCallCallee(previous, beforeWord);
			const declaration = signatureDeclaration && !stack.some((open) => open.declaration);
			const signature =
				declaration ||
				headers.active ||
				stack.some((open) => open.signature) ||
				(language !== "json" && char === "[" && stack.at(-1)?.char === "{") ||
				importClause ||
				["const", "let", "var", "export", "type", "#", "!"].includes(previous) ||
				(language !== "json" && [":", "<", "&", "|"].includes(previous)) ||
				(language === "ts" && previous === "=>" && !valueArrow);
			const protectedRange =
				signature ||
				(char === "(" && !call && !(previous === "=>" && valueArrow)) ||
				stack.some((open) => open.protected);
			const foldable =
				templateDepth === 0 &&
				char !== "(" &&
				!classBody &&
				!protectedRange &&
				(char === "{" || !expressionEnd || language === "json");
			stack.push({
				char,
				line,
				headerLine: char === "(" ? wordLine : line,
				target: char !== "(" && !expressionEnd,
				foldable,
				protected: protectedRange,
				signature,
				interpolation: false,
				control: char === "(" && controls.has(previous),
				call,
				valueParameters: char === "(" && stack.at(-1)?.call === true && ["(", ","].includes(previous),
				declaration,
			});
			valueArrow = false;
			expressionEnd = false;
			previous = char;
			i++;
			continue;
		}
		if (char === "}" || char === "]" || char === ")") {
			const open = stack.pop();
			if (ambiguousAngleDepth !== undefined && stack.length < ambiguousAngleDepth) ambiguousAngleDepth = undefined;
			if (!open || { "{": "}", "[": "]", "(": ")" }[open.char] !== char) return fail("unbalanced_delimiters");
			if (open.interpolation) {
				template = true;
				i++;
				continue;
			}
			headers.close(open, stack.length, line);
			if (open.foldable && line - open.line - 1 >= settings.minBodyLines)
				ranges.push({ startLine: open.line + 1, endLine: line - 1 });
			valueArrow = open.valueParameters;
			if (open.declaration) signatureDeclaration = false;
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
		// JSX, escaped identifiers and unknown lexical tokens cannot establish safe delimiters.
		if (char === "<" && language === "ts" && expressionEnd) {
			const span = typeArgumentsSpan(source, i + 1);
			if (span) {
				line += span.newlines;
				i = span.end;
				previous = ">";
				continue;
			}
			// A comparison can finish at its enclosing delimiter; an unresolved generic
			// reaching a brace must fail rather than fold constraint/signature members.
			if (!/^\s*\{/.test(source.slice(i + 1))) ambiguousAngleDepth = stack.length;
		}
		if (char === "<" && !expressionEnd && /^<\/?[A-Za-z]/.test(source.slice(i)))
			return fail("ambiguous_angle_syntax");
		if (!";:,.?=><!~+-*%&|^".includes(char)) return fail("unknown_token");
		if (char === ";") {
			importClause = false;
			signatureDeclaration = false;
			if (ambiguousAngleDepth === stack.length) ambiguousAngleDepth = undefined;
		}
		if (!headers.punctuation(char === "=" && next === ">" ? "=>" : char, stack.length, line))
			return fail("unproved_header");
		valueArrow = valueArrow && previous === ")" && char === "=" && next === ">";
		previous = char === "=" && next === ">" ? "=>" : char;
		i += previous === "=>" ? 2 : 1;
		expressionEnd = char === "." ? null : false;
	}
	return template || templateDepth || stack.length || headers.unfinished
		? fail("unbalanced_or_unproved_header")
		: { status: "parsed", ranges: headers.filter(ranges) };
}
