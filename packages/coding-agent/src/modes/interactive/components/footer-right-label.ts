import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import type { FooterRightForm, FooterSegment } from "./footer-layout.ts";
import { keyText } from "./keybinding-hints.ts";

/** One coloured run of the right side, in render order. */
export type RightSideRun = {
	readonly text: string;
	readonly color: "muted" | "warning" | "accent" | "dim" | "borderMuted";
};

/**
 * Color the right side of the footer: (provider) muted, model accent, the
 * `effort <level>` label muted and its cycle-key hint dim.
 *
 * The runs come from the values that produced the text, never from re-parsing
 * the rendered string: an account display name may legally contain `)` or `:`,
 * and a regex over the rendered segment would then colour the provider prefix
 * as the model, or cut the model id into a "thinking level".
 *
 * `plain` is the rendered segment, which the layout pass may have truncated at
 * the tail (and whose truncation can append reset sequences); each run is
 * clipped to the visible text that survived, so a run boundary can never cut
 * an escape sequence in half.
 */
export function colorRightSide(runs: readonly RightSideRun[], plain: string): string {
	const text = stripTerminalSequences(plain);
	if (!text) return "";
	let offset = 0;
	let colored = "";
	for (const run of runs) {
		if (offset >= text.length) break;
		const visible = text.slice(offset, offset + run.text.length);
		if (visible.length === 0) break;
		colored += theme.fg(run.color, visible);
		offset += visible.length;
	}
	return colored;
}

export interface RightLabelInput {
	readonly modelName: string;
	readonly fastIndicator: string;
	readonly routed: { readonly modelId: string; readonly thinkingLevel: string | undefined } | undefined;
	readonly reasoning: boolean;
	readonly thinkingLevel: string;
	readonly providerPrefix: string;
	readonly separator: string;
}

export interface RightLabel {
	readonly forms: [FooterRightForm, ...FooterRightForm[]];
	readonly floor: FooterSegment;
	readonly floorRuns: readonly RightSideRun[];
}

function segmentFromRuns(runs: readonly RightSideRun[]): FooterSegment {
	const plain = runs.map((run) => run.text).join("");
	return { plain, colored: colorRightSide(runs, plain) };
}

/**
 * The right-label ladder, richest first. The readable `model • effort <level>`
 * forms (with and without the cycle-key hint) are used only when the whole footer
 * fits as is, so they never cost a live stat or a path character. Below that the
 * label is the compact `model:<level>` the footer always had: with the provider
 * prefix while middle stats may still elide, then alone with pwd elision, down to
 * the same floor as before. The key hint therefore drops first, then the readable
 * label, then the provider; the model id and its level stay as long as they ever did.
 */
export function buildRightLabel(input: RightLabelInput): RightLabel {
	const modelRuns: RightSideRun[] = [
		...(input.fastIndicator ? [{ text: input.fastIndicator, color: "warning" as const }] : []),
		{ text: input.modelName, color: "accent" },
	];
	const routedRuns: RightSideRun[] = [];
	if (input.routed) {
		routedRuns.push({ text: ` \u2192 ${input.routed.modelId}`, color: "accent" });
		if (input.routed.thinkingLevel) routedRuns.push({ text: `:${input.routed.thinkingLevel}`, color: "dim" });
	}
	const level = input.thinkingLevel || "off";
	const compactRuns: RightSideRun[] = input.reasoning
		? [...modelRuns, { text: `:${level}`, color: "dim" }, ...routedRuns]
		: [...modelRuns, ...routedRuns];
	const labelRuns: RightSideRun[] = [
		...modelRuns,
		...routedRuns,
		{ text: input.separator, color: "borderMuted" },
		{ text: `effort ${level}`, color: "muted" },
	];
	const cycleKey = input.reasoning ? keyText("app.thinking.cycle") : "";
	const providerRuns: RightSideRun[] = input.providerPrefix ? [{ text: input.providerPrefix, color: "muted" }] : [];

	const richer: FooterRightForm[] = [];
	if (cycleKey) {
		const hintRuns = [...providerRuns, ...labelRuns, { text: ` (${cycleKey})`, color: "dim" as const }];
		richer.push({ ...segmentFromRuns(hintRuns), fitsWith: "everything" });
	}
	if (input.reasoning) richer.push({ ...segmentFromRuns([...providerRuns, ...labelRuns]), fitsWith: "everything" });
	if (input.providerPrefix) {
		richer.push({ ...segmentFromRuns([...providerRuns, ...compactRuns]), fitsWith: "middle-elision" });
	}
	const floor = segmentFromRuns(compactRuns);
	const forms: [FooterRightForm, ...FooterRightForm[]] = [floor];
	forms.unshift(...richer);
	return { forms, floor, floorRuns: compactRuns };
}
