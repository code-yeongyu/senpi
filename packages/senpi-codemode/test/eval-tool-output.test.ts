import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type ToolContent = AgentToolResult<unknown>["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;
type ImagePart = Extract<ToolContent, { type: "image" }>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function isTextPart(part: ToolContent): part is TextPart {
	return part.type === "text";
}

function isImagePart(part: ToolContent): part is ImagePart {
	return part.type === "image";
}

function textOf(resultValue: AgentToolResult<unknown>): string {
	return resultValue.content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");
}

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "senpi-codemode-eval-output-"));
	temporaryDirectories.push(path);
	return path;
}

describe("eval tool output pipeline", () => {
	it("reports sink truncation metadata, spill path, JSON displays, and cell details", async () => {
		// Given
		const artifactsDir = await temporaryDirectory();
		const jsonValue = { answer: 42, nested: ["a", "b"] };
		const kernel = new FakeKernel([
			{ type: "text", stream: "stdout", data: `${"x".repeat(120_000)}\n` },
			{
				type: "display",
				mimeType: "application/json",
				dataBase64: Buffer.from(JSON.stringify(jsonValue)).toString("base64"),
			},
			{ type: "status", event: { op: "read", path: "/tmp/input.json" } },
			result("sink-cell", "tail-value", 17),
		]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
			settings: {
				...defaultCodemodeSettings,
				outputSink: { ...defaultCodemodeSettings.outputSink, maxColumns: 0 },
			},
			artifactsDir,
		});

		// When
		const toolResult = await tool.execute(
			"sink-cell",
			{ language: "js", code: "display({answer: 42})", title: "sink" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		expect(toolResult.details).toMatchObject({
			language: "js",
			languages: ["js"],
			title: "sink",
			durationMs: 17,
			truncated: true,
			jsonOutputs: [jsonValue],
			statusEvents: [{ op: "read", path: "/tmp/input.json" }],
			cells: [
				{
					index: 0,
					title: "sink",
					code: "display({answer: 42})",
					language: "js",
					status: "complete",
					durationMs: 17,
					statusEvents: [{ op: "read", path: "/tmp/input.json" }],
				},
			],
			meta: expect.objectContaining({ direction: "middle", truncatedBy: "middle" }),
		});
		const artifactPath = toolResult.details.meta?.artifactId;
		expect(artifactPath).toEqual(expect.any(String));
		if (artifactPath === undefined) throw new Error("truncated eval did not expose its spill path");
		expect(existsSync(artifactPath)).toBe(true);
		expect(toolResult.details.notice).toBe(`[Full output: ${artifactPath}]`);
		expect(textOf(toolResult)).toContain("display[1]");
		expect(textOf(toolResult)).toContain("tail-value");
	});

	it("streams a monotonically growing live tail attributed to the running cell", async () => {
		// Given
		const kernel = new FakeKernel([
			{ type: "text", stream: "stdout", data: "first\n" },
			{ type: "text", stream: "stdout", data: "second\n" },
			result("live-cell", "done"),
		]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
		const updates: { readonly content: readonly ToolContent[]; readonly details: EvalToolDetails }[] = [];
		const onUpdate: AgentToolUpdateCallback<EvalToolDetails> = (update) => {
			updates.push(update);
		};

		// When
		const toolResult = await tool.execute(
			"live-cell",
			{ language: "js", code: "print('first'); print('second')" },
			undefined,
			onUpdate,
			fakeExtensionContext(),
		);

		// Then
		const outputs = updates.flatMap((update) => {
			const output = update.details.cells?.[0]?.output;
			return output === undefined ? [] : [output];
		});
		const firstIndex = outputs.indexOf("first\n");
		const secondIndex = outputs.indexOf("first\nsecond\n");
		expect(firstIndex).toBeGreaterThanOrEqual(0);
		expect(secondIndex).toBeGreaterThan(firstIndex);

		const firstLiveUpdate = updates.find((update) => update.details.cells?.[0]?.output === "first\n");
		const secondLiveUpdate = updates.find((update) => update.details.cells?.[0]?.output === "first\nsecond\n");
		expect(firstLiveUpdate).toMatchObject({
			content: [{ type: "text", text: "1/1 cells running\n[1] js running\nfirst\n" }],
			details: { cells: [{ output: "first\n", status: "running" }] },
		});
		expect(secondLiveUpdate).toMatchObject({
			content: [{ type: "text", text: "1/1 cells running\n[1] js running\nfirst\nsecond\n" }],
			details: { cells: [{ output: "first\nsecond\n", status: "running" }] },
		});
		expect(updates.at(-1)?.details.cells?.[0]?.status).toBe("complete");
		expect(textOf(toolResult)).toBe("first\nsecond\ndone");
	});

	it("keeps the live content preview bounded to the active cell's latest eight lines", async () => {
		// Given
		const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}\n`);
		const kernel = new FakeKernel([
			...lines.map((data) => ({ type: "text" as const, stream: "stdout" as const, data })),
			result("bounded-live-cell", ""),
		]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});
		const updates: { readonly content: readonly ToolContent[]; readonly details: EvalToolDetails }[] = [];

		// When
		await tool.execute(
			"bounded-live-cell",
			{ language: "js", code: "for (let i = 1; i <= 10; i++) print(i)" },
			undefined,
			(update) => updates.push(update),
			fakeExtensionContext(),
		);

		// Then
		const completeLiveUpdate = updates.find((update) => update.details.cells?.[0]?.output === lines.join(""));
		expect(completeLiveUpdate).toMatchObject({
			content: [{ type: "text", text: `1/1 cells running\n[1] js running\n${lines.slice(-8).join("")}` }],
			details: { cells: [{ output: lines.join(""), status: "running" }] },
		});
	});

	it("resizes display images and appends dimension notes to text output", async () => {
		// Given
		const kernel = new FakeKernel([
			{ type: "display", mimeType: "image/png", dataBase64: "source-image" },
			result("image-cell", ""),
		]);
		const imageResizer = vi.fn(async () => ({
			image: { type: "image" as const, mimeType: "image/jpeg", data: "resized-image" },
			dimensionNote: "[Image: original 800x600, displayed at 400x300.]",
		}));
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
			imageResizer,
		});

		// When
		const toolResult = await tool.execute(
			"image-cell",
			{ language: "js", code: "display(image)" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		expect(imageResizer).toHaveBeenCalledWith(
			{ type: "image", mimeType: "image/png", data: "source-image" },
			undefined,
		);
		expect(toolResult.content.filter(isImagePart)).toEqual([
			{ type: "image", mimeType: "image/jpeg", data: "resized-image" },
		]);
		expect(textOf(toolResult)).toContain("display image 1: [Image: original 800x600, displayed at 400x300.]");
	});

	it("preserves partial output and marks the cell as errored when the kernel fails", async () => {
		// Given
		const kernel = new FakeKernel([
			{ type: "text", stream: "stdout", data: "partial\n" },
			errorResult("error-cell", "boom"),
		]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: vi.fn(),
		});

		// When
		const toolResult = await tool.execute(
			"error-cell",
			{ language: "js", code: "throw new Error('boom')" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then
		expect(textOf(toolResult)).toContain("partial");
		expect(textOf(toolResult)).toContain("boom");
		expect(toolResult.details).toMatchObject({
			isError: true,
			cells: [{ status: "error", output: expect.stringContaining("partial") }],
		});
	});
});
