import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { elideHead, FOOTER_SEPARATOR, type FooterTopLeftSegment } from "./footer-layout.ts";

export interface FooterTopLineInput {
	readonly width: number;
	readonly segments: readonly FooterTopLeftSegment[];
	readonly minimalRight: string;
	readonly fullRight: string | undefined;
	readonly separator?: string;
	readonly minPadding?: number;
}

export interface FooterTopLinePlan {
	readonly segments: readonly FooterTopLeftSegment[];
	readonly right: string;
}

function segmentsWidth(segments: readonly FooterTopLeftSegment[], separator: string): number {
	if (segments.length === 0) return 0;
	return (
		segments.reduce((total, segment) => total + visibleWidth(segment.text), 0) +
		visibleWidth(separator) * (segments.length - 1)
	);
}

function fits(segments: readonly FooterTopLeftSegment[], right: string, input: FooterTopLineInput): boolean {
	return (
		segmentsWidth(segments, input.separator ?? FOOTER_SEPARATOR) + (input.minPadding ?? 2) + visibleWidth(right) <=
		input.width
	);
}

function elidePathToFit(
	segments: readonly FooterTopLeftSegment[],
	right: string,
	input: FooterTopLineInput,
): readonly FooterTopLeftSegment[] | undefined {
	const path = segments.find((segment) => segment.kind === "path");
	if (!path) return undefined;
	const separator = input.separator ?? FOOTER_SEPARATOR;
	const rest = segments.filter((segment) => segment.kind !== "path");
	const budget =
		input.width -
		(input.minPadding ?? 2) -
		visibleWidth(right) -
		segmentsWidth(rest, separator) -
		(rest.length > 0 ? visibleWidth(separator) : 0);
	if (budget < 2) return undefined;
	return segments.map((segment) =>
		segment.kind === "path" ? { ...segment, text: elideHead(segment.text, budget) } : segment,
	);
}

function planForRight(right: string, input: FooterTopLineInput): FooterTopLinePlan | undefined {
	if (fits(input.segments, right, input)) {
		return { segments: input.segments, right };
	}

	const path = input.segments.find((segment) => segment.kind === "path");
	const preferPathElision = path !== undefined && visibleWidth(path.text) > Math.floor(input.width / 3);
	if (preferPathElision) {
		const elided = elidePathToFit(input.segments, right, input);
		if (elided && fits(elided, right, input)) {
			return { segments: elided, right };
		}
	}

	const withoutSession = input.segments.filter((segment) => segment.kind !== "session");
	if (fits(withoutSession, right, input)) {
		return { segments: withoutSession, right };
	}
	const elided = elidePathToFit(withoutSession, right, input);
	return elided && fits(elided, right, input) ? { segments: elided, right } : undefined;
}

export function planFooterTopLine(input: FooterTopLineInput): FooterTopLinePlan {
	if (input.fullRight) {
		const full = planForRight(input.fullRight, input);
		if (full) return full;
	}
	const minimal = planForRight(input.minimalRight, input);
	if (minimal) return minimal;

	const separator = input.separator ?? FOOTER_SEPARATOR;
	const anchors = input.segments.filter((segment) => segment.kind !== "session");
	const leftBudget = input.width - (input.minPadding ?? 2) - visibleWidth(input.minimalRight);
	if (leftBudget >= 1) {
		return {
			segments: [
				{
					color: "muted",
					kind: "fallback",
					text: elideHead(anchors.map((segment) => segment.text).join(separator), leftBudget),
				},
			],
			right: input.minimalRight,
		};
	}
	return {
		segments: [],
		right: truncateToWidth(input.minimalRight, input.width, ""),
	};
}
