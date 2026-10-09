import type { AgentToolResult } from "@code-yeongyu/senpi";
import { visibleWidth } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalToolDetails, EvalToolInput } from "../src/tool/types.ts";
import { callContext, plainTheme, resultContext, stripAnsi } from "./eval-render-fixtures.ts";

const STARTED_AT = 1_700_000_000_000;

function cellResult(cell: Partial<EvalCellResult>): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: "" }],
		details: {
			language: "js",
			durationMs: cell.durationMs ?? 0,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					code: "work();",
					language: "js",
					output: "",
					status: "running",
					...cell,
				},
			],
		},
	};
}

function renderResult(
	result: AgentToolResult<EvalToolDetails>,
	options: { width: number; now?: number; args?: Partial<EvalToolInput> },
): string[] {
	return renderEvalResult(result, { expanded: false, isPartial: true }, plainTheme(), {
		...resultContext({
			args: { language: "js", code: "work();", summary: "fixture", ...options.args },
			...(options.now === undefined ? {} : { now: options.now }),
		}),
		spinnerFrame: 2,
	})
		.render(options.width)
		.map(stripAnsi);
}

function renderStreamingCall(args: Parameters<typeof renderEvalCall>[0], width: number): string[] {
	return renderEvalCall(args, plainTheme(), {
		...callContext({ now: STARTED_AT }),
		spinnerFrame: 2,
	})
		.render(width)
		.map(stripAnsi);
}

const PY_INDENTED = ["for i in range(3):", "    if i % 2:", "        print(i)", "    else:", "        pass"].join("\n");

describe("eval live window keeps indentation (senpi#2933 review HIGH-A)", () => {
	it("Given an indented Python cell when streaming then the window keeps leading whitespace", async () => {
		const lines = renderStreamingCall({ language: "py", code: PY_INDENTED, summary: "indented" }, 80);
		const text = lines.join("\n");
		expect(text).toContain("    if i % 2:");
		expect(text).toContain("        print(i)");
		expect(text).toContain("    else:");
		expect(text).toContain("        pass");
	});

	it("Given an indented Python cell when running then the window keeps inner spacing and indentation", async () => {
		const lines = renderResult(
			cellResult({ status: "running", language: "py", code: PY_INDENTED, startedAt: STARTED_AT }),
			{ width: 80, now: STARTED_AT + 1_000 },
		);
		const text = lines.join("\n");
		expect(text).toContain("    if i % 2:");
		expect(text).toContain("        print(i)");
	});

	it("Given code with tabs then the window expands them without collapsing indentation", async () => {
		const code = "def f():\n\treturn 1";
		const lines = renderStreamingCall({ language: "py", code, summary: "tabs" }, 80);
		expect(lines.join("\n")).toContain("  return 1");
	});
});

const LONG_SQL = [
	'const q = "SELECT u.id, u.name, u.email, o.total, o.created_at FROM users u JOIN orders o ON o.user_id = u.id WHERE o.total > 100 ORDER BY o.created_at DESC LIMIT 50";',
	"const rows = await db.query(q);",
	"for (const row of rows) {",
	"  print(row.name);",
	"}",
	'print("done");',
].join("\n");

const plainRow = (lines: readonly string[], needle: string): string =>
	(lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")).find((line) => line.includes(needle)) ?? "").trimEnd();

describe("eval live window always shows the newest line (senpi#2933 review HIGH-B)", () => {
	it("Given the 6-line JS cell with one long SQL line at 100 cols then the newest line is visible and the marker is not zero", async () => {
		const lines = renderStreamingCall({ language: "js", code: LONG_SQL, summary: "long sql" }, 100);
		const text = lines.join("\n");
		expect(text).toContain('print("done");');
		expect(text).not.toContain("0 earlier code lines");
	});

	it("Given the 6-line JS cell with one long SQL line at 40 cols then the newest line is visible and the hidden SQL line is counted once", async () => {
		const lines = renderStreamingCall({ language: "js", code: LONG_SQL, summary: "long sql" }, 40);
		const text = lines.join("\n");
		expect(text).toContain('print("done");');
		expect(text).toContain("1 earlier code lines");
	});

	it("Given a long SQL line whose head rows are cut by the window when running with output then the marker counts the cut line", async () => {
		// Given: the SQL line wraps to several rows at 40 cols and the 3-row code window keeps
		// only its last row plus the final line, so the SQL line is partly visible: it counts.
		const code = [LONG_SQL.split("\n")[0] ?? "", 'print("done");'].join("\n");
		const lines = renderResult(
			cellResult({ status: "running", language: "js", code, startedAt: STARTED_AT, output: "chunk" }),
			{ width: 40, now: STARTED_AT + 1_000 },
		);
		const text = lines.join("\n");
		expect(text).toContain('print("done");');
		expect(text).toContain("1 earlier code lines");
	});

	it("Given 3 source lines with one 150-char line at 40 cols then the newest line stays visible", async () => {
		const code = `a();\nconst x = "${"y".repeat(150)}";\nc();`;
		const lines = renderStreamingCall({ language: "js", code, summary: "wrapped" }, 40);
		expect(lines.join("\n")).toContain("c();");
	});

	it("Given 20 wrapped source lines at 40 cols then the marker counts hidden source lines", async () => {
		const code = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = "${"z".repeat(60)}";`).join("\n");
		const lines = renderStreamingCall({ language: "js", code, summary: "wrapped twenty" }, 40);
		const text = lines.join("\n");
		const marker = lines.find((line) => line.includes("earlier code lines"));
		expect(marker).toBeDefined();
		// Every shown row belongs to line 20 (38 rows wrap over 40 source rows), so the 19
		// source lines whose first row is hidden fold into the exact count (review HIGH-B).
		const count = Number(/(\d+) earlier code lines/u.exec(marker ?? "")?.[1]);
		expect(count).toBe(19);
		expect(text).toContain("line20");
	});

	it("Given a single source line taller than the window then its last rows show with the marker", async () => {
		const code = `const big = "${"w".repeat(500)}";`;
		const lines = renderStreamingCall({ language: "js", code, summary: "tall" }, 40);
		const text = lines.join("\n");
		expect(text).toContain("earlier code lines");
		expect(text).toContain("w".repeat(20));
	});
});

describe("eval live output tail counts hidden rows exactly (senpi#2933 review NEW-1)", () => {
	const cellWithOutput = (output: string): Partial<EvalCellResult> => ({
		status: "running",
		startedAt: STARTED_AT,
		code: "work();",
		output,
	});

	it.each([
		{ count: 3, earlier: 2 },
		{ count: 4, earlier: 3 },
		{ count: 10, earlier: 9 },
	] as const)(
		"Given $count output lines at 80 cols then the marker says $earlier earlier lines and shows the last line",
		({ count }) => {
			const output = Array.from({ length: count }, (_, i) => `line-${i + 1}`).join("\n");
			const lines = renderResult(cellResult(cellWithOutput(output)), { width: 80, now: STARTED_AT + 1_000 });
			const text = lines.join("\n");
			expect(text).toContain(`${count - 1} earlier output lines`);
			expect(text).toContain(`line-${count}`);
			expect(text).not.toContain(`line-${count - 1}`);
		},
	);

	it("Given one 200-char output line at 40 cols then the marker counts every hidden wrapped row", async () => {
		const lines = renderResult(cellResult(cellWithOutput("x".repeat(200))), { width: 40, now: STARTED_AT + 1_000 });
		const text = lines.join("\n");
		// The 200-char line wraps to 6 rows at a 38-cell body; only the last row is shown.
		expect(text).toContain("5 earlier output lines");
		expect(text).not.toContain("4 earlier output lines");
	});
});

describe("eval live status tail keeps the newest event rows (senpi#2933 review NEW-2)", () => {
	it("Given two 2-line events at 40 cols then the newest event is visible and older rows fold into the marker", async () => {
		const lines = renderResult(
			cellResult({
				status: "running",
				startedAt: STARTED_AT,
				statusEvents: [
					{ op: "log", message: "first\nsecond" },
					{ op: "log", message: "third\nfourth" },
				],
			}),
			{ width: 40, now: STARTED_AT + 1_000 },
		);
		const text = lines.join("\n");
		expect(text).toContain("fourth");
		expect(plainRow(lines, "fourth").endsWith("fourth"), "the kept row is whole, never clipped").toBe(true);
		expect(text).not.toContain("first");
		expect(text).not.toContain("second");
		expect(text).toContain("1 earlier status events");
	});

	it("Given one 4-line event at 40 cols then its newest row is kept and the marker counts the rows cut from its head", async () => {
		const lines = renderResult(
			cellResult({
				status: "running",
				startedAt: STARTED_AT,
				statusEvents: [{ op: "log", message: "line1\nline2\nline3\nline4" }],
			}),
			{ width: 40, now: STARTED_AT + 1_000 },
		);
		const text = lines.join("\n");
		expect(text).toContain("line4");
		expect(plainRow(lines, "line4").endsWith("line4"), "the kept row is whole, never clipped").toBe(true);
		expect(text).toContain("3 earlier rows of this event");
		expect(text).not.toContain("line3");
		expect(text).not.toContain("line2");
		expect(text).not.toContain("line1");
		expect(text).not.toContain("earlier status events");
	});

	it.each([20, 25, 30] as const)(
		"Given the stored bound, folded events and a cut event at %i cols then the one-row marker keeps both counts",
		(width) => {
			const lines = renderResult(
				cellResult({
					status: "running",
					startedAt: STARTED_AT,
					statusEvents: [
						{ op: "status-events-omitted", count: 19901 },
						{ op: "log", message: "older" },
						{ op: "log", message: "a\nb\nc\nd\ne" },
					],
				}),
				{ width, now: STARTED_AT + 1_000 },
			);
			const marker = plainRow(lines, "\u251c \u2026");
			expect(marker, JSON.stringify(lines)).toMatch(/19902\D.*\b4\D*$/u);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		},
	);
});

describe("eval live block: truly constant total height (senpi#2933 review HIGH-C)", () => {
	const HEIGHTS_WIDTHS = [40, 80, 200] as const;
	it.each(HEIGHTS_WIDTHS)("Given every tail shape at %i cols then the total height is identical", async (width) => {
		const heights: Array<[string, number]> = [];
		const push = (label: string, cell: Partial<EvalCellResult>) => {
			heights.push([
				label,
				renderResult(cellResult({ status: "running", startedAt: STARTED_AT, ...cell }), {
					width,
					now: STARTED_AT + 1_000,
				}).length,
			]);
		};
		push("no-tail", { code: "a();" });
		push("1-output", { code: "a();", output: "one line" });
		push("2-output", { code: "a();", output: "one\ntwo" });
		push("10-output", { code: "a();", output: Array.from({ length: 10 }, (_, i) => `out-${i + 1}`).join("\n") });
		push("1-event", { code: "a();", statusEvents: [{ op: "log", message: "one" }] });
		push("200-char-event", { code: "a();", statusEvents: [{ op: "log", message: "x".repeat(200) }] });
		push("4-line-event", { code: "a();", statusEvents: [{ op: "log", message: "line1\nline2\nline3\nline4" }] });
		push("2x100-events", {
			code: "a();",
			statusEvents: [
				{ op: "log", message: "a".repeat(100) },
				{ op: "log", message: "b".repeat(100) },
			],
		});
		push("3-events", {
			code: "a();",
			statusEvents: Array.from({ length: 3 }, (_, i) => ({ op: "log", message: `event-${i + 1}` })),
		});
		push("output+event", { code: "a();", output: "chunk", statusEvents: [{ op: "log", message: "one" }] });
		expect(new Set(heights.map(([, h]) => h)).size, JSON.stringify(heights)).toBe(1);
	});

	it("Given a long status event at 40 cols then its newest rows stay inside the budget and the cut rows are counted", async () => {
		const lines = renderResult(
			cellResult({
				status: "running",
				startedAt: STARTED_AT,
				statusEvents: [{ op: "log", message: "x".repeat(200) }],
			}),
			{ width: 40, now: STARTED_AT + 1_000 },
		);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(lines.join("\n")).toMatch(/[1-9]\d* earlier rows of this event/);
	});

	it("Given one output line when rendered then the block keeps the full height (no flicker)", async () => {
		const one = renderResult(cellResult({ status: "running", startedAt: STARTED_AT, output: "one line" }), {
			width: 80,
			now: STARTED_AT + 1_000,
		});
		const none = renderResult(cellResult({ status: "running", startedAt: STARTED_AT }), {
			width: 80,
			now: STARTED_AT + 1_000,
		});
		expect(one).toHaveLength(none.length);
	});
});
