import { scanBraces } from "./brace-scanner.ts";
import { scanPython } from "./python-scanner.ts";
import type { Fold } from "./scorer.ts";

export type Prototype = {
	readonly text: string;
	readonly folds: readonly Fold[];
	readonly reason: string;
	readonly fallback_reason?: string;
	readonly scanned_folds: number;
};

export function renderPrototype(source: string, folds: readonly Fold[]): string {
	const lines = source.split("\n");
	const parts: string[] = [];
	let cursor = 0;
	for (const fold of folds) {
		parts.push(...lines.slice(cursor, fold.start - 1), "…");
		cursor = fold.end;
	}
	parts.push(...lines.slice(cursor));
	if (folds.length)
		parts.push(
			"",
			`[Elided source: ${folds.map((f) => `offset=${f.start} limit=${f.end - f.start + 1}`).join("; ")}]`,
		);
	return parts.join("\n");
}

export function heuristic(source: string, language: string): Prototype {
	const raw = (reason: string, scanned_folds = 0): Prototype => ({
		text: source,
		folds: [],
		reason,
		fallback_reason: reason,
		scanned_folds,
	});
	const lines = source.split("\n");
	if (language === "markdown" || language === "txt") return raw("prose_exempt");
	if (lines.length < 100 || lines.length > 2000 || Buffer.byteLength(source) > 51200) return raw("size_gate");
	if (language === "tsx" && /<\/?[A-Za-z]/.test(source)) return raw("jsx_requires_parser");
	if (language === "json") {
		try {
			JSON.parse(source);
		} catch (error) {
			if (error instanceof SyntaxError) return raw("parse_failure");
			throw error;
		}
	}
	const scan = language === "python" ? scanPython(source) : scanBraces(source, language);
	if (scan.fallbackReason) return raw(scan.fallbackReason);
	const ordered = [...scan.ranges].sort((a, b) => a.start - b.start || b.end - a.end);
	let selected = ordered.filter(
		(range, i) => !ordered.slice(0, i).some((parent) => parent.start <= range.start && parent.end >= range.end),
	);
	const visible = (folds: readonly Fold[]) => lines.length - folds.reduce((n, f) => n + f.end - f.start + 1, 0);
	while (visible(selected) < 50) {
		let refined = false;
		for (const parent of selected) {
			const children = ordered.filter((r) => r.start > parent.start && r.end < parent.end);
			const direct = children.filter(
				(r, i) => !children.slice(0, i).some((p) => p.start <= r.start && p.end >= r.end),
			);
			const next = selected
				.filter((r) => r !== parent)
				.concat(direct)
				.sort((a, b) => a.start - b.start);
			if (visible(next) <= 100) {
				selected = next;
				refined = true;
				break;
			}
		}
		if (!refined) return raw("visible_budget_unreachable", ordered.length);
	}
	if (!selected.length || visible(selected) > 100) return raw("skeleton_exceeds_budget", ordered.length);
	const text = renderPrototype(source, selected);
	return text.length < source.length
		? { text, folds: selected, reason: "folded", scanned_folds: ordered.length }
		: raw("no_byte_saving", ordered.length);
}
