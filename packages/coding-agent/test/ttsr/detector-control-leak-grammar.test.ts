import { describe, expect, it } from "vitest";
import { createControlLeakDetector } from "../../src/core/extensions/builtin/ttsr/detectors/control-leak.ts";
import {
	bracket,
	CONTROL_LEAK_CTX,
	ctrl,
	expectLeakMatchEverywhere,
	expectNoLeakMatchEverywhere,
	PLAIN_PROSE_PREFIX,
	runSplitMatrix,
	sgml,
} from "./control-leak-helpers.ts";

function joined(token: string, count: number, separator: string): string {
	return Array.from({ length: count }, () => token).join(separator);
}

function normalRun(token: string, count: number) {
	return runSplitMatrix(`${PLAIN_PROSE_PREFIX} ${joined(token, count, " ")}`, [token]);
}

describe("structural grammar acceptance", () => {
	it("CTRL name at maximum length 32 is valid and fires", () => {
		const name = `a${"b".repeat(31)}`;
		const token = ctrl(name);
		expectLeakMatchEverywhere(normalRun(token, 4), {
			tokenId: `ctrl:${name}`,
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("SGML tokenizer special token (longest known name) fires", () => {
		const name = "start_of_image";
		const token = sgml(name);
		expectLeakMatchEverywhere(normalRun(token, 4), {
			tokenId: `sgml:${name}`,
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("SGML name that is not a tokenizer special token is markup and stays silent (omo#10789)", () => {
		expectNoLeakMatchEverywhere(normalRun(sgml(`a${"b".repeat(15)}`), 4));
	});

	it("BRACKET name at maximum length 16 is valid and fires", () => {
		const name = `A${"B".repeat(15)}`;
		const token = bracket(name);
		expectLeakMatchEverywhere(normalRun(token, 4), {
			tokenId: `bracket:${name}`,
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("BRACKET name at minimum length 2 is valid and fires", () => {
		const token = bracket("AB");
		expectLeakMatchEverywhere(normalRun(token, 4), {
			tokenId: "bracket:AB",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});

	it("underscores and digits after the first letter are valid in names", () => {
		const token = ctrl("a_1b_2");
		expectLeakMatchEverywhere(normalRun(token, 4), {
			tokenId: "ctrl:a_1b_2",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: PLAIN_PROSE_PREFIX.length + 1,
		});
	});
});

describe("structural grammar rejection", () => {
	it("CTRL name of length 33 is rejected", () => {
		const token = ctrl(`a${"b".repeat(32)}`);
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("SGML name of length 17 is rejected", () => {
		const token = sgml(`a${"b".repeat(16)}`);
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("BRACKET name of length 17 is rejected", () => {
		const token = bracket(`A${"B".repeat(16)}`);
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("BRACKET name of length 1 is rejected", () => {
		const token = bracket("A");
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("digit-first CTRL name is rejected", () => {
		const token = ctrl("1abc");
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("hyphen inside CTRL name is rejected", () => {
		const token = ctrl("ab-cd");
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("dot inside SGML name is rejected", () => {
		const token = sgml("ab.cd");
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("lowercase BRACKET name is rejected", () => {
		const token = bracket("Sep");
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("empty names are rejected for every family", () => {
		const tokens = [ctrl(""), sgml(""), sgml("/"), bracket("")];
		const fixture = `${PLAIN_PROSE_PREFIX} ${joined(tokens.join(" "), 5, " ")}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, tokens));
	});

	it("space after the opening angle is rejected", () => {
		const token = `${String.fromCharCode(60)} s${String.fromCharCode(62)}`;
		expectNoLeakMatchEverywhere(normalRun(token, 5));
	});

	it("name matching is case-sensitive across occurrences", () => {
		const lower = ctrl("Sep");
		const upper = ctrl("sEp");
		const pair = `${lower} ${upper}`;
		const fixture = Array.from({ length: 4 }, () => pair).join(" ");
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [lower, upper]));
	});

	it("SGML slash and non-slash variants are distinct tokens", () => {
		const open = sgml("s");
		const close = sgml("/s");
		const pair = `${open} ${close}`;
		const fixture = Array.from({ length: 4 }, () => pair).join(" ");
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [open, close]));
	});

	it("flush on an unclosed candidate returns null", () => {
		const detector = createControlLeakDetector();
		const state = detector.createState();
		const partial = `${String.fromCharCode(60)}${String.fromCharCode(124)}sep`;
		expect(detector.checkDelta(state, partial, CONTROL_LEAK_CTX)).toBeNull();
		expect(detector.flush === undefined ? null : detector.flush(state, CONTROL_LEAK_CTX)).toBeNull();
	});
});

describe("scalar offsets", () => {
	it("wide scalars before the run keep anomaly offsets in UTF-16 units", () => {
		const token = ctrl("sep");
		const fixture = `\u{1F30A} ${joined(token, 4, " ")}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [token]), {
			tokenId: "ctrl:sep",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: 3,
		});
	});
});
