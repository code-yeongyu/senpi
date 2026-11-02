import { describe, expect, it } from "vitest";

import {
	bracket,
	ctrl,
	expectLeakMatchEverywhere,
	expectNoLeakMatchEverywhere,
	PLAIN_PROSE_PREFIX,
	requireEvidence,
	runSplitMatrix,
	sgml,
} from "./control-leak-helpers.ts";

function joined(token: string, count: number, separator: string): string {
	return Array.from({ length: count }, () => token).join(separator);
}

const LESS_THAN = String.fromCharCode(60);
const PIPE = String.fromCharCode(124);
const FENCE = "`".repeat(3);

describe("detector-control-leak hard negatives", () => {
	it("B-N1 isolated token inside discussion prose stays silent", () => {
		const token = ctrl("sep");
		const fixture = `The separator token is ${token}.`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N2 four different tokens once each never form a run", () => {
		const tokens = [ctrl("im_start"), ctrl("im_end"), sgml("s"), bracket("PAD")];
		const fixture = tokens.join(" ");
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, tokens));
	});

	it("B-N3 CTRL(sep) x3 after several paragraphs is below normal threshold", () => {
		const token = ctrl("sep");
		const fixture = `${PLAIN_PROSE_PREFIX}\n\n${PLAIN_PROSE_PREFIX} ${joined(token, 3, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N4 fenced documentation example with CTRL(sep) x7 stays silent", () => {
		const token = ctrl("sep");
		const fixture = `${FENCE}\nExample configuration:\n${joined(token, 7, "\n")}\n${FENCE}\n`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N5 inline code CTRL(im_start) x3 stays silent", () => {
		const token = ctrl("im_start");
		const fixture = `use \`${joined(token, 3, " ")}\` here`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N6 discussion vocabulary promotes CTRL(eot_id) x4 to quotation threshold", () => {
		const token = ctrl("eot_id");
		const fixture = `tokenizer example sequence is ${joined(token, 4, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N7 comma-separated copies reset the run", () => {
		const token = ctrl("sep");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 5, ", ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N8 alternating CTRL(im_start) and CTRL(im_end) pairs never combine", () => {
		const start = ctrl("im_start");
		const end = ctrl("im_end");
		const pair = `${start} ${end}`;
		const fixture = Array.from({ length: 10 }, () => pair).join(" ");
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [start, end]));
	});

	it("B-N9 structurally valid custom name x10 fires at normal threshold", () => {
		const token = ctrl("custom_marker");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 10, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:custom_marker",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-N9 isolated custom name records pending evidence without a match", () => {
		const token = ctrl("custom_marker");
		const fixture = `${PLAIN_PROSE_PREFIX} ${token} trailing prose`;
		const results = runSplitMatrix(fixture, [token]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(evidence.tokenId, result.label).toBe("ctrl:custom_marker");
			expect(evidence.quotationLike, result.label).toBe(false);
		}
	});

	it("B-N10 SGML(div) x7 inside fenced documentation stays silent", () => {
		const token = sgml("div");
		const fixture = `${FENCE}\ndocumentation:\n${joined(token, 7, "\n")}\n${FENCE}\n`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N10 alternating SGML tags in fenced documentation stay silent", () => {
		const tokens = [sgml("div"), sgml("span"), sgml("code")];
		const cycle = tokens.join("");
		const fixture = `${FENCE}\n${Array.from({ length: 9 }, () => cycle).join("\n")}\n${FENCE}\n`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, tokens));
	});

	it("B-N10 SGML(div) x8 outside quotation is markup and stays silent (omo#10789)", () => {
		const token = sgml("div");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 8, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N10 tokenizer SGML(/s) x8 outside quotation fires", () => {
		const token = sgml("/s");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 8, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "sgml:/s",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-N11 lowercase bracket name x10 is prose and stays silent", () => {
		const token = bracket("sep");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 10, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N11 BRACKET(MASK) x10 fires at normal threshold", () => {
		const token = bracket("MASK");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 10, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "bracket:MASK",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-N12 unclosed candidate plus prose stays silent", () => {
		const partial = [LESS_THAN, PIPE, "unclosed_name"].join("");
		const fixture = `${PLAIN_PROSE_PREFIX} ${partial} and then the prose continues`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [partial]));
	});

	it("B-N12 over-long unclosed candidate stays bounded and parser recovers", () => {
		const partial = [LESS_THAN, PIPE, "a".repeat(100)].join("");
		const token = ctrl("sep");
		const fixture = `${partial} ${PLAIN_PROSE_PREFIX} ${joined(token, 4, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [partial, token]), {
			tokenId: "ctrl:sep",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: partial.length + 1 + PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-N13 BRACKET(SEP) x7 in an indented tokenizer fixture stays silent", () => {
		const token = bracket("SEP");
		const fixture = `    tokenizer fixture:\n    ${joined(token, 7, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [token]));
	});

	it("B-N14 one occurrence of every family stays silent and keeps latest evidence", () => {
		const tokens = [ctrl("sep"), sgml("s"), bracket("PAD")];
		const fixture = `${PLAIN_PROSE_PREFIX} ${tokens.join(" ")}`;
		const results = runSplitMatrix(fixture, tokens);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			expect(requireEvidence(result).tokenId, result.label).toBe("bracket:PAD");
		}
	});
});
