import type { AgentToolResult } from "@code-yeongyu/senpi";
import { visibleWidth } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalToolDetails } from "../src/tool/types.ts";
import { callContext, plainTheme, renderLines, resultContext, stripAnsi } from "./eval-render-fixtures.ts";

const code = "const sh = async (cmd) => {\n  return cmd;\n};\nawait sh('ls')";
const summary = "Listing the repo with a shell helper";

function liveResult(cell: Partial<EvalCellResult>): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: "" }],
		details: {
			language: "js",
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			cells: [{ index: 0, code, language: "js", output: "partial out", status: "running", durationMs: 0, ...cell }],
		},
	};
}

function render(result: AgentToolResult<EvalToolDetails>, expanded = false, width = 90): string[] {
	const component = renderEvalResult(result, { expanded, isPartial: true }, plainTheme(), {
		...resultContext({ args: { language: "js", code, summary } }),
		spinnerFrame: 1,
	});
	return component.render(width).map(stripAnsi);
}

function renderCall(args: Parameters<typeof renderEvalCall>[0], spinnerFrame: number | undefined = 1): string[] {
	return renderLines(renderEvalCall(args, plainTheme(), { ...callContext(), spinnerFrame })).map(stripAnsi);
}

describe("live eval rows lead with the cell's summary (senpi#2802)", () => {
	it("Given a running cell when its row renders collapsed then the header leads with the summary and the code window follows (senpi#2933)", async () => {
		const lines = render(liveResult({ summary }));

		expect(lines[0]).toMatch(/^╭─ . Listing the repo with a shell helper · eval js running/u);
		expect(lines.join("\n")).toContain("partial out");
		expect(lines.at(-1)).toBe("╰─");
	});

	it("Given a queued and a detached cell when their rows render then both lead with the summary", async () => {
		expect(render(liveResult({ summary, status: "queued", queuedBehind: ["toolu_A"] }), false, 120)[0]).toMatch(
			/^╭─ ○ Listing the repo with a shell helper · eval js queued · queued behind toolu_A/u,
		);
		expect(render(liveResult({ summary, status: "detached" }))[0]).toMatch(
			/^╭─ ↗ Listing the repo with a shell helper · eval js detached/u,
		);
	});

	it("Given a running cell when its row is expanded then the code is shown once and the summary is not repeated", async () => {
		const text = render(liveResult({ summary }), true).join("\n");

		expect(text).toContain("const sh = async (cmd) => {");
		expect(text.split(summary)).toHaveLength(2);
	});

	it("Given a running cell without a summary when its row renders then the headline is its first code line, cut to the width", async () => {
		const lines = render(liveResult({ code: `  \n${"x".repeat(200)} = 1` }), false, 60);

		expect(lines[0]).toMatch(/^╭─ . x+… · eval js running/u);
		expect(lines[0]?.length).toBeLessThanOrEqual(60);
	});

	it("Given a running cell with no output yet when its row renders collapsed then it is the fixed-height block (senpi#2933)", async () => {
		const lines = render(liveResult({ summary, output: "" }));

		expect(lines).toHaveLength(8);
		expect(lines[0]).toMatch(/^╭─ . Listing the repo with a shell helper · eval js running/u);
		expect(lines.at(-1)).toBe("╰─");
	});

	it("Given a completed cell when its row renders collapsed then it is one line with icon summary status and duration (senpi#2933)", async () => {
		const lines = render(liveResult({ summary, status: "complete", durationMs: 1_000 }));

		expect(lines).toEqual([expect.stringMatching(/^╶─ ✓ Listing the repo with a shell helper · eval js done · 1s/u)]);
	});

	it("Given a call still streaming with only code when it renders then it shows a headline row instead of failing", async () => {
		expect(renderCall({ code: "const sh = 1;" })).toEqual(["╶─ ⠙ const sh = 1; · eval"]);
		expect(renderCall({})).toEqual(["╶─ ⠙ … · eval"]);
		expect(renderCall({ code: "const sh = 1;" }, undefined)).toBeDefined();
	});

	it("Given a complete call before its result arrives when it renders then the header says streaming (senpi#2933)", async () => {
		const lines = renderCall({ language: "js", code, summary });
		expect(lines).toHaveLength(8);
		expect(lines[0]).toMatch(/^╭─ . Listing the repo with a shell helper · eval js streaming/u);
		expect(lines.at(-1)).toBe("╰─");
	});
});

describe("live eval rows stay clean in the terminal (senpi#2831)", () => {
	it("Given a summary carrying escape and control characters when its live row renders then the header is one clean line with none of them", async () => {
		const lines = render(liveResult({ summary: "\u001b[31mred\u001b[0m step\rsecond\nthird", output: "" }));

		expect(lines[0]).not.toMatch(/[\u001b\r\n]/u);
		expect(lines[0]).toMatch(/^╭─ . .*red.* step.*second.*third · eval js running/u);
		expect(lines).toHaveLength(8);
	});

	it("Given a wide-character summary when its live row renders in a narrow terminal then the header fits the width in screen cells", async () => {
		const wide = "저장소의 모든 파일을 셸 도우미로 나열하고 결과를 요약합니다 😀😀";
		const lines = render(liveResult({ summary: wide, output: "" }), false, 40);

		expect(lines[0]).toMatch(/^╭─ . 저장소.*… · eval js running/u);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(lines).toHaveLength(8);
	});

	it("Given a peek or stop call still streaming without its cell id when it renders then the title has no undefined", async () => {
		expect(renderCall({ action: "peek", cell_id: "" })).toEqual(["eval peek"]);
		expect(renderCall({ action: "stop", cell_id: "" })).toEqual(["eval stop"]);
		expect(renderCall({ action: "peek", cell_id: "toolu_A" })).toEqual(["eval peek toolu_A"]);
	});

	it("Given a cell without a summary whose first code line carries escape and control characters when its live row renders then the header and window carry none of them (senpi#2839)", async () => {
		const lines = render(liveResult({ code: "\u001b[31mawait step()\u001b[0m\rhidden\tmore\nsecond()", output: "" }));

		expect(lines[0]).not.toMatch(/[\u001b\r\t]/u);
		expect(lines[0]).toMatch(/^╭─ . .*await step\(\).*hidden.*more · eval js running/u);
		expect(lines.join("\n")).not.toMatch(/[\u001b\r\t]/u);
	});

	it("Given a cell without a summary whose first code line is only escape and control characters when its live row renders then the headline is the next line with content (senpi#2850)", async () => {
		const lines = render(liveResult({ code: "\u001b[0m\r\nreal()\nlater()", output: "" }));

		expect(lines[0]).toMatch(/^╭─ . real\(\) · eval js running/u);
		expect(lines).toHaveLength(8);
	});
});
