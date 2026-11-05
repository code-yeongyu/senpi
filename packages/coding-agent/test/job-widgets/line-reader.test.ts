import { describe, expect, it } from "vitest";

import {
	createWidgetRedactor,
	defaultLineMatcher,
	JobWidgetRuntime,
	MAX_LINE_CHARS,
	PRIVATE_KEY_MARKER,
	SourceLineReader,
	TextTap,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { block, harness, ScriptedSource, validSpec } from "./support.ts";

function readAll(chunks: readonly string[], close = false): string[][] {
	const source = new ScriptedSource("out");
	const reader = new SourceLineReader(source);
	return chunks.map((chunk, index) => {
		source.append(chunk);
		if (close && index === chunks.length - 1) source.open = false;
		return reader.read(false).lines;
	});
}

describe("source line reader", () => {
	const cases: [string, string[], string[][], boolean?][] = [
		["joins a line split across reads", ["step 1", "2 done\nst", "ep 13\n"], [[], ["step 12 done"], ["step 13"]]],
		[
			"turns CR progress redraws and CRLF into line breaks",
			["Rendering 1 / 64 samples\rRendering 2 / 64 samples\r\nFra:2\r\n"],
			[["Rendering 1 / 64 samples", "Rendering 2 / 64 samples", "Fra:2"]],
		],
		["reads a CR split from its LF as one break plus a blank line", ["a\r", "\nb\n"], [["a"], ["", "b"]]],
		[
			"strips ANSI sequences and control characters but keeps tabs",
			["\x1b[32mok\x1b[0m\tlint\x07\n\x1b]0;title\x07done\n"],
			[["ok\tlint", "done"]],
		],
		["ends the line in progress when the source closes", ["tail without newline"], [["tail without newline"]], true],
	];

	it.each(cases)("%s", (_name, chunks, expected, close) => {
		expect(readAll(chunks, close)).toEqual(expected);
	});

	it("offers the newest CR segment of the line in progress as progress, never as a line", () => {
		const source = new ScriptedSource("out");
		const reader = new SourceLineReader(source);
		const step = (text: string): [string[], string | undefined] => {
			source.append(text);
			return [reader.read(false).lines, reader.progress];
		};
		expect(step("\r10%\r20%\r30%")).toEqual([["", "10%", "20%"], "30%"]);
		expect(step("\x1b[32m\r[####  ] 31%\x1b[3")).toEqual([["30%"], "[####  ] 31%"]);
		expect(step("2m\n")).toEqual([["[####  ] 31%"], undefined]);
		expect(step("a line still being wri")).toEqual([[], undefined]);
		// A long token-shaped tail may be a secret cut mid-write: held back until the segment completes.
		const token = "abcdefghij0123456789";
		expect(step(`tten\rtoken ${token}`)).toEqual([["a line still being written"], "token"]);
		expect(step(`\rtoken ${token} ok`)).toEqual([[`token ${token}`], `token ${token} ok`]);
	});

	it("stages a CR progress bar at its current step, and the complete lines once it ends", () => {
		const out = new ScriptedSource("out");
		const h = harness(undefined, out);
		out.append("Downloading\n\r 10%\r 20%\r 99%");
		h.ingest();
		expect(h.derive({ authoring: true }).view.stage).toBe("99%");
		expect(h.derive().view).toMatchObject({ stage: "99%", lines: 3 });
		out.append("\rdone\n");
		h.ingest();
		expect(h.derive().view).toMatchObject({ stage: "done", lines: 5 });
	});

	it("redacts a CR progress segment before it stands for the stage", () => {
		const out = new ScriptedSource("out");
		const redactor = createWidgetRedactor();
		const runtime = new JobWidgetRuntime({
			spec: undefined,
			matcher: defaultLineMatcher,
			startTime: 0,
			now: () => 0,
			redactSource: () => redactor.source(),
		});
		out.append("copying\r -----BEGIN RSA PRIVATE KEY-----");
		runtime.ingest([out], false);
		const stage = runtime.derive({ label: "job", lineStage: true, authoring: true }).view.stage;
		expect(stage).toContain(PRIVATE_KEY_MARKER);
		expect(stage).not.toContain("BEGIN");
	});

	it("cuts lines at the line limit", () => {
		const [[line]] = readAll([`${"x".repeat(MAX_LINE_CHARS + 10)}\n`]);
		expect(line).toHaveLength(MAX_LINE_CHARS);
	});

	it("skips the line torn by a dropped prefix so no rule reads half a line", () => {
		const spec = validSpec({
			title: "bench",
			rules: [{ from: "out", match: String.raw`(?P<model>\S+) tok=(?P<tok>[\d.]+)`, key: "model" }],
			blocks: [{ kind: "bars", field: "tok", agg: "last", label: "tok/s" }],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("BENCH gpt-6-luna tok=1");
		h.ingest();
		out.append("80\nBENCH gpt-6-sol tok=90\n");
		h.ingest();
		out.append("BENCH gpt-6-luna tok=186\nBENCH gpt-6-sol tok=95\n");
		out.dropThrough("BENCH gpt-6-l");
		h.ingest();
		out.append("BENCH gpt-6-luna tok=190");
		out.open = false;
		h.ingest();
		expect(block(h.derive(), "bars").items.map((item) => [item.key, item.value])).toEqual([
			["gpt-6-luna", 190],
			["gpt-6-sol", 95],
		]);
	});
});

describe("text tap", () => {
	it("keeps its newest text and reports where a reader's offset was dropped", () => {
		const tap = new TextTap("out", "cmd", 8);
		tap.append("0123456789");
		tap.append("abc");
		expect(tap.read(0)).toEqual({ start: 5, end: 13, text: "56789abc", open: true });
		tap.close();
		tap.append("ignored");
		expect(tap.read(11)).toEqual({ start: 11, end: 13, text: "bc", open: false });
	});
});
