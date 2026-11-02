import { describe, it } from "vitest";

import {
	expectLeakMatchEverywhere,
	expectNoLeakMatchEverywhere,
	runSplitMatrix,
	sgml,
} from "./control-leak-helpers.ts";

// senpi#3880: `s` and `mask` are tokenizer special tokens AND ordinary markup (HTML strikethrough,
// SVG mask). Markup uses of them must never abort a reply; a leaked unquoted `</s>` EOS run still must.
const FENCE = "`".repeat(3);

describe("control-token-leak and markup that spells a special token (senpi#3880)", () => {
	it("nested HTML strikethrough is markup", () => {
		const fixture = `${sgml("s").repeat(4)}text${sgml("/s").repeat(4)}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [sgml("s"), sgml("/s")]));
	});

	it("nested SVG mask is markup", () => {
		const fixture = `${sgml("mask").repeat(4)}content${sgml("/mask").repeat(4)}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [sgml("mask"), sgml("/mask")]));
	});

	it("a fenced SVG example of mask closers is a documented example", () => {
		const fixture = `${FENCE}svg\n${sgml("/mask").repeat(8)}\n${FENCE}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [sgml("/mask")]));
	});

	// senpi#3973 review: a fenced `</s>` loop is a degeneration, not a documented example.
	it("a fenced run of EOS closers still fires at the quotation threshold", () => {
		const close = sgml("/s");
		const fixture = `${FENCE}html\n${close.repeat(8)}\n${FENCE}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [close]), {
			tokenId: "sgml:/s",
			occurrences: 8,
			context: "quotation",
			anomalyStartOffset: fixture.indexOf(close),
		});
	});

	it("a single fenced EOS closer is a documented example", () => {
		const close = sgml("/s");
		const fixture = `${FENCE}\nThe model ends a turn with ${close}.\n${FENCE}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [close]));
	});

	it("an unclosed strikethrough does not hide a later EOS run", () => {
		const open = sgml("s");
		const close = sgml("/s");
		const fixture = `${open}draft text that never closes. ${"x".repeat(2100)} and then ${close.repeat(4)}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [open, close]), {
			tokenId: "sgml:/s",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: fixture.indexOf(close.repeat(4)),
		});
	});

	it("a fenced opener does not credit a closer in prose", () => {
		const open = sgml("s");
		const close = sgml("/s");
		const fixture = `${FENCE}html\n${open}old\n${FENCE}\nThen ${close.repeat(4)}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [open, close]), {
			tokenId: "sgml:/s",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: fixture.indexOf(close.repeat(4)),
		});
	});

	it("a whitespace-only run of leaked openers does not hide the closers after it", () => {
		const open = sgml("s");
		const close = sgml("/s");
		const fixture = `answer: ${Array(4).fill(open).join(" ")} x ${close.repeat(5)}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [open, close]), {
			tokenId: "sgml:/s",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: fixture.indexOf(close.repeat(5)) + close.length,
		});
	});

	it("closers beyond the opened markup still fire as a leaked EOS run", () => {
		const open = sgml("s");
		const close = sgml("/s");
		const fixture = `${open}struck${close} and then ${close.repeat(4)}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [open, close]), {
			tokenId: "sgml:/s",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: fixture.indexOf(close.repeat(4)),
		});
	});
});
