import {
	applyEdits,
	childNodes,
	type Edit,
	parseFile,
	programOf,
	type SourceNode,
	sourceNode,
	sourceNodes,
} from "./display-js-ast.ts";

const ARRAY_BREAK_LENGTH = 60;
const INDENT = "  ";

function forHeaderEdits(code: string, node: SourceNode, edits: Edit[]): void {
	if (node.type === "ForStatement") {
		const body = sourceNode(node.record.body);
		const open = code.indexOf("(", node.start);
		const close = body === undefined ? -1 : code.lastIndexOf(")", body.start);
		if (open >= 0 && close > open) {
			const parts = ["init", "test", "update"].map((key) => {
				const part = sourceNode(node.record[key]);
				return part === undefined ? "" : code.slice(part.start, part.end);
			});
			const header = parts.every((part) => part.length === 0) ? ";;" : parts.join("; ");
			if (code.slice(open + 1, close) !== header) edits.push({ start: open + 1, end: close, text: header });
		}
	}
	for (const child of childNodes(node)) forHeaderEdits(code, child, edits);
}

function lineIndent(code: string, position: number): string {
	const line = code.slice(code.lastIndexOf("\n", position - 1) + 1);
	return line.slice(0, line.length - line.trimStart().length);
}

// Only whitespace in a gap is rewritten: a gap between babel element nodes can also hold the
// parentheses of a parenthesized element, and those must stay (senpi#2076).
function gapTokens(code: string, start: number, end: number): string {
	return code.slice(start, end).replace(/\s+/gu, "");
}

// A one-line array longer than ARRAY_BREAK_LENGTH puts each element on its own line (senpi#2050).
// `forcedIndent` is the indentation of an element line an enclosing break just created.
function arrayEdits(code: string, node: SourceNode, forcedIndent: string | undefined, edits: Edit[]): void {
	const rawElements = node.record.elements;
	const elements = sourceNodes(rawElements);
	const first = elements[0];
	const last = elements.at(-1);
	const text = code.slice(node.start, node.end);
	const breaks =
		node.type === "ArrayExpression" &&
		Array.isArray(rawElements) &&
		elements.length === rawElements.length &&
		elements.length >= 2 &&
		text.length > ARRAY_BREAK_LENGTH &&
		!text.includes("\n");
	if (!breaks || first === undefined || last === undefined) {
		for (const child of childNodes(node)) arrayEdits(code, child, forcedIndent, edits);
		return;
	}
	const base = forcedIndent ?? lineIndent(code, node.start);
	const inner = `${base}${INDENT}`;
	edits.push({
		start: node.start + 1,
		end: first.start,
		text: `\n${inner}${gapTokens(code, node.start + 1, first.start)}`,
	});
	elements.slice(1).forEach((element, index) => {
		const start = elements[index]?.end ?? element.start;
		const [before = "", after = ""] = gapTokens(code, start, element.start).split(",");
		edits.push({ start, end: element.start, text: `${before},\n${inner}${after}` });
	});
	edits.push({ start: last.end, end: node.end - 1, text: `${gapTokens(code, last.end, node.end - 1)}\n${base}` });
	for (const element of elements) arrayEdits(code, element, inner, edits);
}

/** Printer fix-ups on the restored cell: `for (a; b; c)` headers, then long-array breaks. */
export function finishLayout(code: string): string | undefined {
	const program = programOf(parseFile(code));
	if (program === undefined) return undefined;
	const headerEdits: Edit[] = [];
	forHeaderEdits(code, program, headerEdits);
	const withHeaders = applyEdits(code, headerEdits);
	const reparsed = programOf(parseFile(withHeaders));
	if (reparsed === undefined) return undefined;
	const breaks: Edit[] = [];
	arrayEdits(withHeaders, reparsed, undefined, breaks);
	return applyEdits(withHeaders, breaks);
}
