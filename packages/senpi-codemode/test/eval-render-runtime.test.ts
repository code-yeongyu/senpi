import { homedir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { evalResult, renderLines, resultContext } from "./eval-render-fixtures.ts";

function detailsWithCell(runtime: EvalToolDetails["runtime"]): EvalToolDetails {
	return {
		language: "py",
		durationMs: 0,
		toolCalls: [],
		truncated: false,
		...(runtime === undefined ? {} : { runtime }),
		cells: [
			{
				index: 0,
				code: "print(1)",
				language: "py",
				output: "",
				status: "complete",
				...(runtime === undefined ? {} : { runtime }),
			},
		],
	};
}

describe("eval renderer runtime badge", () => {
	it("shows version and home-contracted interpreter path in the collapsed one-line cell row (senpi#2933)", () => {
		const pythonPath = join(homedir(), ".venv", "bin", "python3");
		const result = evalResult(detailsWithCell({ name: "python", version: "3.14.7", path: pythonPath }), "done");

		const rendered = renderLines(
			renderEvalResult(result, { expanded: false, isPartial: false }, undefined, resultContext(undefined, false)),
		);

		expect(rendered[0]).toBe("╶─ ✓ print(1) · eval py (3.14.7, ~/.venv/bin/python3) done");
	});

	it("labels the js runtime with its name so node and bun are distinguishable", () => {
		const details: EvalToolDetails = {
			language: "js",
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			runtime: { name: "node", version: "26.7.0" },
		};

		const rendered = renderLines(
			renderEvalResult(
				evalResult(details, "complete"),
				{ expanded: false, isPartial: false },
				undefined,
				resultContext(undefined, false),
			),
		);

		expect(rendered[0]).toBe("eval js (node 26.7.0) done");
	});

	it("renders the collapsed one-line row without any badge when runtime is unknown (senpi#2933)", () => {
		const rendered = renderLines(
			renderEvalResult(
				evalResult(detailsWithCell(undefined), "done"),
				{ expanded: false, isPartial: false },
				undefined,
				resultContext(undefined, false),
			),
		);

		expect(rendered[0]).toBe("╶─ ✓ print(1) · eval py done");
	});

	it("keeps the done row one line at 40 cols by letting the badge drop (senpi#2933 review MEDIUM-1)", () => {
		const pythonPath = join(homedir(), ".venv", "bin", "python3.12");
		const result = evalResult(detailsWithCell({ name: "python", version: "3.12.4", path: pythonPath }), "done");

		const component = renderEvalResult(
			result,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);
		const rendered = component.render(40);

		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toBe("╶─ ✓ print(1) · eval py done");
		expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(40);
	});
});
