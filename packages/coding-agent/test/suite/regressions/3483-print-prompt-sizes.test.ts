import { homedir } from "node:os";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import * as dynamicPrompt from "../../../src/core/dynamic-prompt/build.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";
import { goldenCases, memoryBlock, realisticOptions } from "./3483-print-prompt-sizes-fixtures.ts";
import goldens from "./3483-prompt-goldens.json" with { type: "json" };

// Fixed input facts from the original capture, not the machine running this test.
// Inject through the workstation renderer's existing facts option; keep the
// committed baseline facts unchanged, including the complete workstation block.
const fixedFacts = vi.hoisted(() => ({
	osLine: "darwin",
	kernel: "Darwin 25.6.0",
	arch: "arm64",
	cpu: "Apple M4 Pro (14 cores)",
	gpu: "Apple M4 Pro",
	terminal: "xterm-256color",
}));
vi.mock("../../../src/core/dynamic-prompt/workstation.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/dynamic-prompt/workstation.ts")>();
	return {
		...actual,
		buildWorkstationSection: (options: Parameters<typeof actual.buildWorkstationSection>[0]) =>
			actual.buildWorkstationSection({ ...options, facts: fixedFacts }),
	};
});

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function fixture(unsafe = false, transform?: (prompt: string) => string) {
	const extensionsResult = await createTestExtensionsResult([
		{
			path: "/fixture/extensions/memory.ts",
			factory: (pi) => {
				pi.on(
					"before_agent_start",
					(event) => ({
						systemPrompt: transform ? transform(event.systemPrompt) : event.systemPrompt + memoryBlock,
					}),
					{ previewSafe: !unsafe },
				);
				pi.registerTool({
					name: "memory_lookup",
					label: "Memory lookup",
					description: "PRIVATE_TOOL_3483 Lookup a memory.",
					parameters: Type.Object({ query: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
				});
			},
		},
	]);
	const resourceLoader = {
		...createTestResourceLoader({ extensionsResult }),
		getAgentsFiles: () => ({
			agentsFiles: [
				...realisticOptions.contextFiles,
				{ path: `${homedir()}/AGENTS.md`, content: "PRIVATE_HOME_3483\n" },
			],
		}),
		getSkills: () => ({ skills: realisticOptions.skills, diagnostics: [] }),
	};
	const harness = await createHarness({ resourceLoader });
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const build = harness.getExtensionRunner().createContext().getPromptCachePrefixRequest;
	if (!build) throw new Error("Missing prefix builder");
	return { harness, build: () => build({ sizesOnly: true }) };
}

// #3483: measured sizes must reflect the actual composed request, not an alternate assembly.
describe("first-turn prompt sizes (#3483)", () => {
	it("measures each named part from the composed prefix request", async () => {
		// Given
		const { harness, build } = await fixture();
		const options = harness.getExtensionRunner().createContext().getSystemPromptOptions?.();
		if (!options) throw new Error("Missing prompt options");
		// When
		const result = await build();
		// Then
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw new Error(result.reason);
		const report = result.request.sizeReport;
		expect(report).toBeDefined();
		if (!report) throw new Error("Missing size report");
		const parts = dynamicPrompt.buildDynamicSystemPromptParts({
			...options,
			selectedTools: options.selectedTools ?? [],
			toolSnippets: options.toolSnippets ?? {},
			promptGuidelines: options.promptGuidelines ?? [],
			contextFiles: options.contextFiles ?? [],
			skills: options.skills ?? [],
		});
		expect(result.request.context.systemPrompt).toBe(parts.map((part) => part.text).join("") + memoryBlock);
		for (const name of new Set(parts.map((part) => part.name))) {
			const matching = parts.filter((part) => part.name === name);
			expect(report.sections.find((section) => section.name === name)?.bytes).toBe(
				matching.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0),
			);
		}
	});

	it("never emits context, skill, extension or tool content", async () => {
		// Given
		const { build } = await fixture();
		// When
		const result = await build();
		// Then
		if (result.status !== "ready") throw new Error(result.reason);
		expect(result.request.sizeReport).toBeDefined();
		if (!result.request.sizeReport) throw new Error("Missing size report");
		const json = JSON.stringify(result.request.sizeReport);
		for (const marker of [
			"PRIVATE_AGENTS_3483",
			"PRIVATE_SKILL_3483",
			"PRIVATE_EXTENSION_3483",
			"PRIVATE_TOOL_3483",
		]) {
			expect(json).not.toContain(marker);
		}
		expect(json).not.toContain(homedir());
		for (const name of ["project_context", "skills", "extension:memory"]) {
			expect(result.request.sizeReport.sections.find((section) => section.name === name)?.bytes).toBeGreaterThan(0);
		}
	});

	it("does not call a provider while reporting", async () => {
		// Given
		const { harness, build } = await fixture();
		const stream = vi.fn(() => {
			throw new Error("Provider must not be called");
		});
		harness.agent.streamFunction = stream;
		// When
		const result = await build();
		// Then
		if (result.status !== "ready") throw new Error(result.reason);
		expect(result.request.sizeReport).toBeDefined();
		expect(stream).not.toHaveBeenCalled();
	});

	it("attributes extensions and provider tools, sorts sizes and preserves the sum", async () => {
		// Given
		const { build } = await fixture();
		// When
		const result = await build();
		// Then
		if (result.status !== "ready") throw new Error(result.reason);
		const report = result.request.sizeReport;
		expect(report).toBeDefined();
		if (!report) throw new Error("Missing size report");
		const tools = report.sections.find((section) => section.name === "tools");
		expect(tools?.count).toBe(result.request.context.tools?.length);
		expect(tools?.topTools?.some((tool) => tool.name === "memory_lookup" && tool.bytes > 0)).toBe(true);
		expect(tools?.bytes).toBe(Buffer.byteLength(JSON.stringify(result.request.context.tools ?? [])));
		expect(report.sections.find((section) => section.name === "extension:memory")).toMatchObject({
			source: "memory",
			bytes: Buffer.byteLength(memoryBlock),
			estimatedTokens: estimateTextTokens(memoryBlock),
		});
		expect(report.sections.map((section) => section.bytes)).toEqual(
			report.sections.map((section) => section.bytes).sort((a, b) => b - a),
		);
		expect(report.total.bytes).toBe(report.sections.reduce((sum, section) => sum + section.bytes, 0));
		expect(report.total.bytes).toBe(
			Buffer.byteLength(result.request.context.systemPrompt ?? "") +
				Buffer.byteLength(JSON.stringify(result.request.context.tools ?? [])),
		);
		expect(report.sections.find((section) => section.name === "project_context")?.boundingSettings).toEqual([
			"contextFiles.maxBytesPerFile",
			"contextFiles.maxTotalBytes",
		]);
	});

	it("recognizes the CLI flag and refuses an unsafe preview with its reason", async () => {
		// Given
		const { build } = await fixture(true);
		// When
		const result = await build();
		// Then
		expect(parseArgs(["--print-prompt-sizes"]).printPromptSizes).toBe(true);
		expect(result).toMatchObject({
			status: "skipped",
			reason: expect.stringContaining("not registered previewSafe"),
		});
	});

	it.each([
		{ name: "prepended", transform: (prompt: string) => memoryBlock + prompt, rewritten: false },
		{ name: "rewritten", transform: () => "Replacement prompt.", rewritten: true },
		{ name: "cleared", transform: () => "", rewritten: true },
	])("keeps the signed sum when a handler $name the prompt", async ({ transform, rewritten }) => {
		// Given
		const { build } = await fixture(false, transform);
		// When
		const result = await build();
		// Then
		if (result.status !== "ready" || !result.request.sizeReport) throw new Error("Expected size report");
		const report = result.request.sizeReport;
		const contribution = report.sections.find((section) => section.name === "extension:memory");
		expect(contribution?.rewritten === true).toBe(rewritten);
		expect(report.total.bytes).toBe(
			Buffer.byteLength(result.request.context.systemPrompt ?? "") +
				Buffer.byteLength(JSON.stringify(result.request.context.tools ?? [])),
		);
	});

	it("refuses inspection when the session has no resolved model", async () => {
		// Given
		const { harness, build } = await fixture();
		// Fault injection at the runtime boundary: no unsafe TypeScript assertion.
		Object.defineProperty(harness.agent.state, "model", { value: undefined });
		// When
		const result = await build();
		// Then
		expect(result).toEqual({ status: "skipped", reason: "no model selected" });
	});
});

describe("prompt-cache byte identity (#3483)", () => {
	it.each(goldenCases)("keeps the captured $name prompt bytes", ({ name, options }) => {
		// Given
		const expected = new Map(Object.entries(goldens.prompts)).get(name);
		if (expected === undefined) throw new Error(`Missing golden ${name}`);
		// When
		const parts = dynamicPrompt.buildDynamicSystemPromptParts(options);
		// Then
		expect(Buffer.from(parts.map((part) => part.text).join(""))).toEqual(Buffer.from(expected));
		expect(Buffer.from(dynamicPrompt.buildDynamicSystemPrompt(options))).toEqual(Buffer.from(expected));
	});

	it("keeps the complete composed prefix including the memory-style extension", async () => {
		// Given
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + memoryBlock }), {
					previewSafe: true,
				});
			},
		]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getSystemPrompt: () => goldens.prompts.realistic,
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		// When
		const result = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.();
		// Then
		if (result?.status !== "ready") throw new Error("Expected composed prefix");
		expect(Buffer.from(result.request.context.systemPrompt ?? "")).toEqual(Buffer.from(goldens.composed));
	});
});
