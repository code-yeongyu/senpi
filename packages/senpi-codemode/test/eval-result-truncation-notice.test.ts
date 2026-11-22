import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

type ToolContent = AgentToolResult<unknown>["content"][number];

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function modelText(toolResult: AgentToolResult<unknown>): string {
	return toolResult.content
		.filter((part): part is Extract<ToolContent, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function runCell(messages: KernelToHostMessage[]): Promise<AgentToolResult<EvalToolDetails>> {
	const artifactsDir = await mkdtemp(join(tmpdir(), "senpi-codemode-2402-"));
	temporaryDirectories.push(artifactsDir);
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", new FakeKernel(messages)]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
		artifactsDir,
	});
	return await tool.execute(
		"cell-2402",
		{ language: "js", code: "value", summary: "long value" },
		undefined,
		undefined,
		fakeExtensionContext(),
	);
}

function artifactPathOf(toolResult: AgentToolResult<EvalToolDetails>): string {
	const artifactPath = toolResult.details.meta?.artifactId;
	if (artifactPath === undefined) throw new Error("truncated eval result recorded no full-output path");
	return artifactPath;
}

describe("eval return values reach the model (senpi#2402)", () => {
	it("delivers a single-line return value longer than the column cap to the model whole", async () => {
		// Given: the issue's value, one ~2.9 KB line, far past the 768-byte column cap
		const value = `START-${Array.from({ length: 60 }, (_, index) => `line${String(index).padStart(2, "0")}-${"abcdefghij".repeat(4)}`).join("|")}-END`;

		// When
		const toolResult = await runCell([result("cell-2402", value)]);

		// Then
		expect(modelText(toolResult)).toBe(value);
		expect(toolResult.details.truncated).toBe(false);
	});

	it("tells the model when a return value exceeds the byte budget, with both sizes and the full-output path", async () => {
		// Given: a single-line return value well past the 50 KB tool-output budget
		const value = `${"v".repeat(120_000)}-END`;

		// When
		const toolResult = await runCell([result("cell-2402", value)]);

		// Then
		const meta = toolResult.details.meta;
		const artifactPath = artifactPathOf(toolResult);
		const text = modelText(toolResult);
		expect(meta?.totalBytes).toBeGreaterThan(value.length);
		expect(text).toContain(`[Output truncated: kept ${meta?.outputBytes} of ${meta?.totalBytes} bytes.`);
		expect(text).toContain(`[Full output: ${artifactPath}]`);
		expect(text.length).toBeLessThan(value.length);
		expect(await readFile(artifactPath, "utf8")).toContain(value);
	});

	it("still clamps streamed output lines to the column cap and says so in the model text", async () => {
		// Given: a printed line past the column cap, then an empty return value
		const printed = "p".repeat(2_000);

		// When
		const toolResult = await runCell([
			{ type: "text", stream: "stdout", data: `${printed}\n` },
			result("cell-2402", ""),
		]);

		// Then
		const text = modelText(toolResult);
		const artifactPath = artifactPathOf(toolResult);
		expect(text).toContain(`${"p".repeat(768)}…`);
		expect(text).not.toContain("p".repeat(769));
		expect(text).toContain("1 line clamped to 768 columns");
		expect(text).toContain(`[Full output: ${artifactPath}]`);
		expect(await readFile(artifactPath, "utf8")).toContain(printed);
	});
});
