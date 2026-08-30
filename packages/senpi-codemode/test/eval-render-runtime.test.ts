import { homedir } from "node:os";
import { join } from "node:path";
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
	it("shows version and home-contracted interpreter path in the cell header", () => {
		const pythonPath = join(homedir(), ".venv", "bin", "python3");
		const result = evalResult(detailsWithCell({ name: "python", version: "3.14.7", path: pythonPath }), "done");

		const rendered = renderLines(
			renderEvalResult(result, { expanded: false, isPartial: false }, undefined, resultContext(undefined, false)),
		);

		expect(rendered[0]).toBe("\u256d\u2500 eval py (3.14.7, ~/.venv/bin/python3) done \u2713");
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

	it("labels the js runtime as native when the kernel runs inside the compiled binary", () => {
		const details: EvalToolDetails = {
			language: "js",
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			runtime: { name: "native", version: "1.4.0" },
		};

		const rendered = renderLines(
			renderEvalResult(
				evalResult(details, "complete"),
				{ expanded: false, isPartial: false },
				undefined,
				resultContext(undefined, false),
			),
		);

		expect(rendered[0]).toBe("eval js (native 1.4.0) done");
	});

	it("renders headers without any badge when runtime is unknown", () => {
		const rendered = renderLines(
			renderEvalResult(
				evalResult(detailsWithCell(undefined), "done"),
				{ expanded: false, isPartial: false },
				undefined,
				resultContext(undefined, false),
			),
		);

		expect(rendered[0]).toBe("\u256d\u2500 eval py done \u2713");
	});
});
