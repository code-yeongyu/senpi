import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { evalResult, evalResultWithOmittedDetails, renderLines, resultContext } from "./eval-render-fixtures.ts";

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

describe("eval renderer state", () => {
	it("Given completed eval details when rendered then header and metadata show status phase and duration", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "js",
				title: "analysis",
				phase: "summarizing",
				durationMs: 11,
				toolCalls: [],
				truncated: false,
			},
			"complete",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		const lines = renderLines(component);
		const statusLine = lines.find((line) => line.includes("eval"));
		const metadataText = lines.join("\n");
		expect.soft(statusLine).toContain("eval");
		expect.soft(statusLine).toContain("js");
		expect.soft(statusLine).toContain("analysis");
		expect.soft(statusLine).toContain("done");
		expect.soft(metadataText).toContain("phase");
		expect.soft(metadataText).toContain("summarizing");
		expect.soft(metadataText).toContain("took 11ms");
	});

	it("Given a final result that completed within one millisecond when rendered then zero duration is shown", () => {
		// Given
		const givenResult = evalResult({ language: "js", durationMs: 0, toolCalls: [], truncated: false }, "complete");

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component)).toContain("took 0ms");
	});

	it("Given a partial result with elapsed duration when rendered then timing remains hidden", () => {
		// Given
		const givenResult = evalResult(
			{ language: "js", durationMs: 17, toolCalls: [], truncated: false },
			"still running",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component).join("\n")).not.toContain("took");
	});

	it("Given empty text output when rendered then no-output marker is shown", () => {
		// Given
		const givenResult = evalResult({ language: "js", durationMs: 1, toolCalls: [], truncated: false }, "");

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component)).toContain("(no output)");
	});

	it("Given image-only result when capabilities and visibility change then text matches the visible image state", () => {
		// Given
		const givenResult = {
			content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
			details: {
				language: "js",
				durationMs: 1,
				toolCalls: [],
				truncated: false,
			},
		} satisfies AgentToolResult<EvalToolDetails>;

		// When
		const hiddenImages = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ showImages: false }),
		);
		const fallbackImage = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ showImages: true, imageProtocol: null }),
		);
		const renderedImage = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ showImages: true, imageProtocol: "kitty" }),
		);

		// Then
		const hiddenText = renderLines(hiddenImages).join("\n");
		const fallbackText = renderLines(fallbackImage).join("\n");
		const renderedText = renderLines(renderedImage).join("\n");
		expect.soft(hiddenText).toContain("(no output)");
		expect.soft(hiddenText).not.toContain("[image:");
		expect.soft(fallbackText).toContain("[image: image/png]");
		expect.soft(fallbackText).not.toContain("(no output)");
		expect.soft(renderedText).not.toContain("[image:");
		expect.soft(renderedText).not.toContain("(no output)");
	});

	it("Given a hostile image MIME label when text fallback renders then terminal controls are inert", () => {
		// Given
		const hostileMimeType = "image/png\x1b]52;c;SGVsbG8=\x07";
		const givenResult = {
			content: [{ type: "image", data: "abc123", mimeType: hostileMimeType }],
			details: {
				language: "js",
				durationMs: 1,
				toolCalls: [],
				truncated: false,
			},
		} satisfies AgentToolResult<EvalToolDetails>;

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ showImages: true, imageProtocol: null }),
		);
		const renderedLabel = renderLines(component).find((line) => line.includes("[image:"));

		// Then
		expect(renderedLabel).toBe("[image: image/png]");
		expect(renderedLabel).not.toMatch(TERMINAL_CONTROL_PATTERN);
		expect(renderedLabel).not.toContain("\x1b");
		expect(renderedLabel).not.toContain("\x07");
		expect(renderedLabel).not.toContain("\x1b]");
	});

	it("Given final result with omitted details when rendered then safe header and no-output marker are shown", () => {
		// Given
		const givenResult = evalResultWithOmittedDetails("");

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		const lines = renderLines(component);
		const header = lines[0] ?? "";
		expect.soft(header).toContain("eval");
		expect.soft(header).toContain("?");
		expect.soft(header).toContain("done");
		expect.soft(lines).toContain("(no output)");
	});

	it("Given host error with omitted details when rendered then header shows error", () => {
		// Given
		const givenResult = evalResultWithOmittedDetails("");

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ isError: true }),
		);

		// Then
		expect(renderLines(component)[0]).toContain("error");
	});

	it("Given error result with duration when rendered then header and metadata show error timing", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "rb",
				durationMs: 5,
				toolCalls: [],
				truncated: false,
				isError: true,
			},
			"boom",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		const lines = renderLines(component);
		const header = lines[0] ?? "";
		const metadataText = lines.join("\n");
		expect.soft(header).toContain("error");
		expect.soft(metadataText).toContain("took 5ms");
	});
});
