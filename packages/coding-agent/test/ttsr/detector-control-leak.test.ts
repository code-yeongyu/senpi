import { describe, expect, it } from "vitest";

import {
	bracket,
	ctrl,
	expectLeakMatchEverywhere,
	expectNoLeakMatchEverywhere,
	LONG_REASONING_PREFIX,
	PLAIN_PROSE_PREFIX,
	runSplitMatrix,
	sgml,
} from "./control-leak-helpers.ts";

function joined(token: string, count: number, separator: string): string {
	return Array.from({ length: count }, () => token).join(separator);
}

describe("detector-control-leak positives", () => {
	it("B-P1 Thinking preamble + CTRL(sep) x3 fires on 3rd as start-like", () => {
		const token = ctrl("sep");
		const prefix = "Thinking... ";
		const fixture = prefix + joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:sep",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: prefix.length,
		});
	});

	it("B-P2 CTRL(im_start) x3 at stream start with spaces fires on 3rd", () => {
		const token = ctrl("im_start");
		const fixture = joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:im_start",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: 0,
		});
	});

	it("B-P3 CTRL(im_end) x4 after 2KB reasoning fires on 4th", () => {
		const token = ctrl("im_end");
		const fixture = `${LONG_REASONING_PREFIX}\n${joined(token, 4, "\n")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:im_end",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: LONG_REASONING_PREFIX.length + 1,
		});
	});

	it("B-P4 CTRL(endoftext) x4 after prose fires on 4th", () => {
		const token = ctrl("endoftext");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 4, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:endoftext",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-P5 Reasoning colon + CTRL(eot_id) x3 fires on 3rd", () => {
		const token = ctrl("eot_id");
		const prefix = "Reasoning: ";
		const fixture = prefix + joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:eot_id",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: prefix.length,
		});
	});

	it("B-P6 CTRL(fim_prefix) x4 later in stream fires on 4th", () => {
		const token = ctrl("fim_prefix");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 4, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:fim_prefix",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-P7 CTRL(fim_middle) x4 with tab and newline gaps fires on 4th", () => {
		const token = ctrl("fim_middle");
		const fixture = `${PLAIN_PROSE_PREFIX} ${[token, token, token, token].join("\t\n")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:fim_middle",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-P8 CTRL(fim_suffix) x3 at start fires on 3rd", () => {
		const token = ctrl("fim_suffix");
		const fixture = joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:fim_suffix",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: 0,
		});
	});

	// An opening `<s>` is HTML strikethrough, so the start-context BOS run uses Gemma's `<bos>` (senpi#3880).
	it("B-P9 SGML(bos) x3 at start fires on 3rd", () => {
		const token = sgml("bos");
		const fixture = joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "sgml:bos",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: 0,
		});
	});

	it("B-P10 SGML(/s) x3 after short preamble fires on 3rd", () => {
		const token = sgml("/s");
		const prefix = "Thinking.\n";
		const fixture = prefix + joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "sgml:/s",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: prefix.length,
		});
	});

	it("B-P11 SGML(pad) x4 after prose fires on 4th", () => {
		const token = sgml("pad");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 4, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "sgml:pad",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-P12 BRACKET(PAD) x4 later fires on 4th", () => {
		const token = bracket("PAD");
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 4, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "bracket:PAD",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("B-P13 BRACKET(UNK) x3 after Analysis preamble fires on 3rd", () => {
		const token = bracket("UNK");
		const prefix = "Analysis... ";
		const fixture = prefix + joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "bracket:UNK",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: prefix.length,
		});
	});

	it("B-P14 BRACKET(CLS) x4 and BRACKET(SEP) x4 after text fire on 4th", () => {
		for (const name of ["CLS", "SEP"]) {
			const token = bracket(name);
			const fixture = `${PLAIN_PROSE_PREFIX} ${joined(token, 4, " ")}`;
			expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
				tokenId: `bracket:${name}`,
				occurrences: 4,
				context: "normal",
				anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
			});
		}
	});
});

describe("start-like context boundaries", () => {
	it("fires on 3rd when first token starts at offset 31 with whitespace prefix", () => {
		const token = ctrl("pad_left");
		const fixture = " ".repeat(31) + joined(token, 3, " ");
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:pad_left",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: 31,
		});
	});

	it("offset 32 whitespace prefix is normal context so x3 stays silent and x4 fires", () => {
		const token = ctrl("pad_left");
		const quiet = " ".repeat(32) + joined(token, 3, " ");
		expectNoLeakMatchEverywhere(runSplitMatrix(quiet, [token]));
		const loud = " ".repeat(32) + joined(token, 4, " ");
		expectLeakMatchEverywhere(runSplitMatrix(loud, [token]), {
			tokenId: "ctrl:pad_left",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: 32,
		});
	});

	it("preamble followed by ordinary prose is normal context", () => {
		const token = ctrl("eot_id");
		const quiet = `Thinking about the answer. ${joined(token, 3, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(quiet, [token]));
	});

	it("preamble trim applies within first 160 chars only", () => {
		const token = ctrl("sep");
		const inside = `Thinking:${" ".repeat(150)}${joined(token, 3, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(inside, [token]), {
			tokenId: "ctrl:sep",
			occurrences: 3,
			context: "start",
			anomalyStartOffset: 159,
		});
		const outside = `Thinking:${" ".repeat(151)}${joined(token, 3, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(outside, [token]));
	});

	it("latches the match and keeps returning it for later deltas", () => {
		const token = ctrl("sep");
		const fixture = joined(token, 3, " ");
		const results = runSplitMatrix(`${fixture} trailing prose ${fixture}`, [token]);
		for (const result of results) {
			expect(result.match, result.label).not.toBeNull();
			expect(result.match?.detail, result.label).toMatchObject({ occurrences: 3 });
			expect(result.flushMatch, result.label).toBe(result.match);
		}
	});
});
