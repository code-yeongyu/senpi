import { describe, expect, it } from "vitest";

import { collapseDetector, createCollapseState } from "../../../src/core/extensions/builtin/ttsr/detectors/collapse.ts";
import {
	createNearDuplicateState,
	updateNearDuplicates,
} from "../../../src/core/extensions/builtin/ttsr/detectors/collapse-near-duplicates.ts";
import {
	createParagraphRepeatState,
	updateParagraphRepeats,
} from "../../../src/core/extensions/builtin/ttsr/detectors/collapse-paragraphs.ts";
import { ScalarScanner } from "../../../src/core/extensions/builtin/ttsr/stream-utils.ts";
import type { DetectorContext, DetectorMatch } from "../../../src/core/extensions/builtin/ttsr/types.ts";

// omo#12213: drafting several replies from one source template quotes the same paragraphs once per reply. Each
// reply carries its own recipient line, so the output is repetitive by design, not a runaway loop.
const TEMPLATE = [
	"Thank you for reaching out about your account. We have reviewed the request and the details you shared with our support team.",
	"If the problem continues after these steps, reply to this message with a screenshot and the time it happened so we can investigate further.",
];
const RECIPIENTS = ["Alice Moreau", "Bob Tanaka", "Carla Diaz", "Dmitri Volkov", "Esme Lindqvist", "Farah Haddad"];

function draft(header: (index: number) => string): string {
	return `${RECIPIENTS.map((_, index) => [header(index), ...TEMPLATE].join("\n\n")).join("\n\n")}\n\n`;
}

const templated = draft((index) => `Reply to ${RECIPIENTS[index]}:`);

function feed(input: string, source: DetectorContext["source"] = "text"): DetectorMatch | null {
	const state = createCollapseState();
	let match: DetectorMatch | null = null;
	for (const char of input)
		match ??= collapseDetector.checkDelta(state, char, { source, streamKey: "s", generation: 1 });
	return match;
}

function paragraphRepeats(input: string): DetectorMatch | null {
	const state = createParagraphRepeatState();
	let match: DetectorMatch | null = null;
	for (const entry of new ScalarScanner().push(input)) match ??= updateParagraphRepeats(state, entry);
	return match;
}

function nearDuplicates(input: string): DetectorMatch | null {
	const state = createNearDuplicateState();
	let match: DetectorMatch | null = null;
	for (const entry of new ScalarScanner().push(input)) match ??= updateNearDuplicates(state, entry);
	return match;
}

describe("omo#12213 template repetition is not a collapse loop", () => {
	it("does not flag template paragraphs that each reply restates under its own recipient", () => {
		expect(paragraphRepeats(templated)).toBeNull();
		expect(nearDuplicates(templated)).toBeNull();
		expect(feed(templated)).toBeNull();
		expect(feed(templated, "thinking")).toBeNull();
	});

	it("still flags the same paragraphs when nothing new separates the repeats", () => {
		const bare = draft(() => "---");
		expect(feed(bare)?.detail.mechanism).toBe("paragraph-repeat");
		expect(paragraphRepeats(bare)?.garbageStartOffset).toBe(
			bare.indexOf(TEMPLATE[0] ?? "", 1 + bare.indexOf(TEMPLATE[0] ?? "")),
		);
	});

	it("still flags a loop whose only change between repeats is a counter", () => {
		const counted = draft((index) => `Attempt ${index + 1}:`);
		expect(paragraphRepeats(counted)?.detail.mechanism).toBe("paragraph-repeat");
		expect(nearDuplicates(counted)?.detail.mechanism).toBe("near-duplicate-paragraphs");
	});
});
