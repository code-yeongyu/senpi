import type { Theme, ThemeColor } from "@code-yeongyu/senpi";

export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
export const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
export const JSON_TREE_MAX_LINES_EXPANDED = 200;
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

const HIDDEN_KEYS = { i: true, __partialJson: true } as const;
const TREE_VERTICAL = "│  ";
const TREE_BRANCH = "├─";
const TREE_LAST = "└─";
// Senpi's Theme exposes fg() but not omp's tree/icon helpers, so fixed glyphs
// replace styledSymbol() while the existing dim/muted color names map directly.
const OBJECT_GLYPH = "◆";
const ARRAY_GLYPH = "◇";
const SCALAR_GLYPH = "•";

type JsonTreeResult = { readonly lines: string[]; readonly truncated: boolean };
type RenderNode = readonly [
	value: unknown,
	key: string | undefined,
	ancestors: boolean[],
	isLast: boolean,
	depth: number,
];
type RenderState = {
	readonly lines: string[];
	readonly theme: Theme | undefined;
	readonly maxDepth: number;
	readonly maxLines: number;
	readonly maxScalarLen: number;
	readonly activeObjects: Set<object>;
	truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function style(theme: Theme | undefined, color: ThemeColor, text: string): string {
	return theme === undefined ? text : theme.fg(color, text);
}

function textWidth(text: string): number {
	let width = 0;
	for (const character of text) width += character === "\t" ? 4 : 1;
	return width;
}

function truncateToColumns(text: string, maxColumns: number): string {
	const limit = Math.max(0, Math.floor(maxColumns));
	if (textWidth(text) <= limit) return text;
	if (limit === 0) return "";
	const marker = "…";
	const prefixLimit = Math.max(0, limit - textWidth(marker));
	let prefix = "";
	let width = 0;
	for (const character of text) {
		const characterWidth = character === "\t" ? 4 : 1;
		if (width + characterWidth > prefixLimit) break;
		prefix += character;
		width += characterWidth;
	}
	return `${prefix}${marker}`;
}

export function formatScalar(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") {
		const escaped = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		return `"${truncateToColumns(escaped, maxLen)}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
	return String(value);
}

function buildTreePrefix(theme: Theme | undefined, ancestors: readonly boolean[]): string {
	return ancestors.map((hasNext) => style(theme, "dim", hasNext ? TREE_VERTICAL : "   ")).join("");
}

export function renderJsonTreeLines(
	value: unknown,
	theme: Theme | undefined,
	maxDepth: number,
	maxLines: number,
	maxScalarLen: number,
): JsonTreeResult {
	const state: RenderState = {
		lines: [],
		theme,
		maxDepth: Math.max(0, Math.floor(maxDepth)),
		maxLines: Math.max(0, Math.floor(maxLines)),
		maxScalarLen: Math.max(0, Math.floor(maxScalarLen)),
		activeObjects: new Set<object>(),
		truncated: false,
	};

	const pushLine = (line: string): boolean => {
		if (state.lines.length >= state.maxLines) {
			state.truncated = true;
			return false;
		}
		state.lines.push(line);
		return true;
	};

	const renderNode = (node: RenderNode): void => {
		const [value, key, ancestors, isLast, depth] = node;
		if (state.lines.length >= state.maxLines) {
			state.truncated = true;
			return;
		}
		const connector = isLast ? TREE_LAST : TREE_BRANCH;
		const prefix = `${buildTreePrefix(state.theme, ancestors)}${style(state.theme, "dim", connector)} `;
		const objectValue = value !== null && typeof value === "object" ? value : undefined;
		if (objectValue !== undefined && state.activeObjects.has(objectValue)) {
			pushLine(`${prefix}${style(state.theme, "dim", "… (circular)")}`);
			return;
		}
		if (objectValue !== undefined) state.activeObjects.add(objectValue);
		ancestors.push(!isLast);
		try {
			if (value === null || value === undefined || typeof value !== "object") {
				const label = key ? style(state.theme, "muted", key) : style(state.theme, "muted", "value");
				if (typeof value === "string" && value.includes("\n")) {
					const stringLines = value.split("\n");
					const visibleLines = Math.min(stringLines.length, Math.max(1, state.maxLines - state.lines.length - 1));
					const first = truncateToColumns(stringLines[0] ?? "", state.maxScalarLen);
					if (
						!pushLine(
							`${prefix}${style(state.theme, "muted", SCALAR_GLYPH)} ${label}: ${style(state.theme, "dim", `"${first}`)}`,
						)
					)
						return;
					const continuePrefix = buildTreePrefix(state.theme, ancestors);
					for (let index = 1; index < visibleLines; index += 1) {
						const line = truncateToColumns(stringLines[index] ?? "", state.maxScalarLen);
						if (!pushLine(`${continuePrefix}   ${style(state.theme, "dim", ` ${line}`)}`)) return;
					}
					if (stringLines.length > visibleLines) {
						state.truncated = true;
						pushLine(
							`${continuePrefix}   ${style(state.theme, "dim", ` …(${stringLines.length - visibleLines} more lines)"`)}`,
						);
					} else {
						const lastIndex = state.lines.length - 1;
						const lastLine = state.lines[lastIndex];
						if (lastLine !== undefined) state.lines[lastIndex] = `${lastLine}${style(state.theme, "dim", '"')}`;
					}
					return;
				}
				pushLine(
					`${prefix}${style(state.theme, "muted", SCALAR_GLYPH)} ${label}: ${style(state.theme, "dim", formatScalar(value, state.maxScalarLen))}`,
				);
				return;
			}

			if (Array.isArray(value)) {
				const label = key ? key : "array";
				if (!pushLine(`${prefix}${style(state.theme, "muted", ARRAY_GLYPH)} ${style(state.theme, "muted", label)}`))
					return;
				if (value.length === 0) {
					pushLine(
						`${buildTreePrefix(state.theme, ancestors)}${style(state.theme, "dim", TREE_LAST)} ${style(state.theme, "dim", "[]")}`,
					);
					return;
				}
				if (depth >= state.maxDepth) {
					pushLine(
						`${buildTreePrefix(state.theme, ancestors)}${style(state.theme, "dim", TREE_LAST)} ${style(state.theme, "dim", "…")}`,
					);
					return;
				}
				for (const [index, child] of value.entries()) {
					renderNode([child, `[${index}]`, ancestors, index === value.length - 1, depth + 1]);
					if (state.lines.length >= state.maxLines) {
						state.truncated = true;
						return;
					}
				}
				return;
			}

			if (!isRecord(value)) return;
			const label = key ? key : "object";
			if (!pushLine(`${prefix}${style(state.theme, "muted", OBJECT_GLYPH)} ${style(state.theme, "muted", label)}`))
				return;
			if (depth >= state.maxDepth) {
				pushLine(
					`${buildTreePrefix(state.theme, ancestors)}${style(state.theme, "dim", TREE_LAST)} ${style(state.theme, "dim", "…")}`,
				);
				return;
			}
			const keys = Object.keys(value);
			if (keys.length === 0) {
				pushLine(
					`${buildTreePrefix(state.theme, ancestors)}${style(state.theme, "dim", TREE_LAST)} ${style(state.theme, "dim", "{}")}`,
				);
				return;
			}
			for (const [index, key] of keys.entries()) {
				renderNode([value[key], key, ancestors, index === keys.length - 1, depth + 1]);
				if (state.lines.length >= state.maxLines) {
					state.truncated = true;
					return;
				}
			}
		} finally {
			ancestors.pop();
			if (objectValue !== undefined) state.activeObjects.delete(objectValue);
		}
	};

	const rootObject = value !== null && typeof value === "object" ? value : undefined;
	if (rootObject !== undefined) state.activeObjects.add(rootObject);
	try {
		if (isRecord(value)) {
			const keys = Object.keys(value).filter((key) => !Object.hasOwn(HIDDEN_KEYS, key));
			for (const [index, key] of keys.entries()) {
				renderNode([value[key], key, [], index === keys.length - 1, 1]);
				if (state.lines.length >= state.maxLines) {
					state.truncated = true;
					break;
				}
			}
		} else if (Array.isArray(value)) {
			for (const [index, child] of value.entries()) {
				renderNode([child, `[${index}]`, [], index === value.length - 1, 1]);
				if (state.lines.length >= state.maxLines) {
					state.truncated = true;
					break;
				}
			}
		} else {
			renderNode([value, undefined, [], true, 0]);
		}
	} finally {
		if (rootObject !== undefined) state.activeObjects.delete(rootObject);
	}

	return { lines: state.lines, truncated: state.truncated };
}
