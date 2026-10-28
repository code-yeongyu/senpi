import { describe, expect, it } from "vitest";

import {
	buildPromptSources,
	JOB_WIDGET_PROMPT_EXAMPLES,
	JOB_WIDGET_SYSTEM_PROMPT,
	MAX_SAMPLE_BYTES,
	renderJobWidgetUserPrompt,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { outSample, RPS_SPEC } from "./author-support.ts";
import { validSpec } from "./support.ts";

const progress = (from: number, count: number): string[] =>
	Array.from({ length: count }, (_, index) => `step ${from + index}/1000 | loss ${(2 / (from + index)).toFixed(4)}`);

describe("job widget prompt samples", () => {
	it("keeps three lines of each shape in the head and the tail, newest of each shape in the tail", () => {
		const [source] = buildPromptSources([
			{
				id: "out",
				label: "out",
				size: 1,
				lines: 400,
				head: ["loading model", ...progress(1, 29)],
				tail: [...progress(300, 30), "[eval] step 330 val_loss 0.2100", ...progress(331, 29)],
			},
		]);
		expect(source?.head).toEqual(["loading model", ...progress(1, 3)]);
		expect(source?.tail).toEqual(["[eval] step 330 val_loss 0.2100", ...progress(357, 3)]);
		expect(source?.omitted).toBe(400 - 4 - 4);
	});

	it("caps samples at 12 KB with a fair share per source, cuts lines at 300 chars, keeps the newest line", () => {
		const long = (prefix: string, count: number): string[] =>
			Array.from({ length: count }, (_, index) => `${prefix} ${"x".repeat(index)} ${"y".repeat(400)}`);
		const sources = buildPromptSources([
			{ id: "out", label: "out", size: 1, lines: 500, head: long("head", 30), tail: long("tail", 60) },
			{ id: "pipe:1", label: "p", size: 1, lines: 3, head: ["a", "b", "c"], tail: [] },
		]);
		const lines = sources.flatMap((source) => [...source.head, ...source.tail]);
		const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
		expect(bytes).toBeLessThanOrEqual(MAX_SAMPLE_BYTES);
		expect(Math.max(...lines.map((line) => line.length))).toBe(300);
		expect(sources[0]?.tail.at(-1)).toMatch(/^tail x{59} /);
		expect(sources[0]?.tail.length).toBeGreaterThan(sources[0]?.head.length ?? 0);
		expect(sources[1]?.head).toEqual(["a", "b", "c"]);
	});

	it("leaves out lines that would open or close the prompt's code fence", () => {
		const [source] = buildPromptSources([outSample(["```", "~~~ python", "  ```js", "rps=4"])]);
		expect(source?.head).toEqual(["rps=4"]);
	});
});

describe("job widget prompts", () => {
	it("renders the brief, every shown line, and the retry's problems", () => {
		const prompt = renderJobWidgetUserPrompt({
			jobId: "bg_1",
			brief: { kind: "bash", command: "./bench.sh", intent: "load test, goal 60 req/s" },
			sources: [outSample(["req 1 rps=40", "req 2 rps=44"])],
			rejected: { answer: "{}", errors: ["rules: expected 1–12 entries, got 0"] },
		});
		expect(prompt).toContain("./bench.sh");
		expect(prompt).toContain("Why it was started: load test, goal 60 req/s");
		expect(prompt).toContain("req 2 rps=44");
		expect(prompt).toContain("- rules: expected 1–12 entries, got 0");
		expect(prompt).toContain("call `respond` again");
	});

	it("names the spec in place and why it is replaced on a re-author", () => {
		const spec = validSpec(RPS_SPEC);
		const prompt = renderJobWidgetUserPrompt({
			jobId: "bg_1",
			brief: { kind: "bash", command: "./bench.sh" },
			sources: [outSample(["qps=3"])],
			previous: { spec, reason: "no rule matched the last 200 lines" },
		});
		expect(prompt).toContain("A spec is already in place, but no rule matched the last 200 lines.");
		expect(prompt).toContain(JSON.stringify(spec));
	});

	// Prompt contract: the system prompt's example specs are what the author copies, so each must
	// pass the validator the answers face.
	it("ships only example specs the validator accepts", () => {
		expect(JOB_WIDGET_PROMPT_EXAMPLES).toHaveLength(4);
		for (const example of JOB_WIDGET_PROMPT_EXAMPLES) {
			expect(() => validSpec(example)).not.toThrow();
			expect(JOB_WIDGET_SYSTEM_PROMPT).toContain(JSON.stringify(example));
		}
	});
});
