import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import imagegenExtension from "../../src/core/extensions/builtin/imagegen/index.ts";
import { GENERATE_IMAGE_TOOL_NAME } from "../../src/core/extensions/builtin/imagegen/tool.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

/**
 * generate_image is eval-only, like bash (senpi#6269): whenever an eval tool is registered it is
 * withheld from the model's direct tool list and reached as `tool.generate_image({ prompt })` inside
 * a cell; without an eval tool it is an ordinary direct tool.
 */

const EVAL_HINT = 'tool.generate_image({ prompt: "..." })';

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function evalExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "eval",
		label: "Eval",
		description: "Evaluate code",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "eval" }], details: {} }),
	});
}

async function makeHarness(options: { withEval: boolean }): Promise<Harness> {
	const extensionFactories = [
		{ factory: imagegenExtension, path: "<builtin:imagegen>" },
		...(options.withEval ? [{ factory: evalExtension, path: "/workspace/extensions/eval.ts" }] : []),
	];
	const harness = await createHarness({ extensionFactories });
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("generate_image is eval-only", () => {
	it("declares eval exposure and stays out of the direct tool list while an eval tool exists", async () => {
		const harness = await makeHarness({ withEval: true });
		harness.session.setActiveToolsByName(["read", GENERATE_IMAGE_TOOL_NAME, "eval"]);

		const registered = harness.session.getAllTools().find((tool) => tool.name === GENERATE_IMAGE_TOOL_NAME);
		expect(registered).toMatchObject({ exposure: "eval" });
		expect(harness.session.getActiveToolNames()).not.toContain(GENERATE_IMAGE_TOOL_NAME);
		expect(harness.session.getActiveToolNames()).toContain("eval");
		expect(harness.session.systemPrompt).toContain(EVAL_HINT);
		expect(harness.agent.removedToolHints[GENERATE_IMAGE_TOOL_NAME]).toContain(EVAL_HINT);
	});

	it("runs through executeTool from the registry without activating the tool", async () => {
		const harness = await makeHarness({ withEval: true });
		harness.session.setActiveToolsByName(["read", "eval"]);

		// No image credentials in the harness: the tool body answers with its configuration failure,
		// which proves the call reached generate_image without a provider request.
		const result = await harness.session.executeTool(
			GENERATE_IMAGE_TOOL_NAME,
			{ prompt: "a cat on a mat" },
			{ activateInactiveTool: true },
		);
		expect(result.details).toMatchObject({ reason: "missing_config" });
		expect(textOf(result).length).toBeGreaterThan(0);
		expect(harness.session.getActiveToolNames()).not.toContain(GENERATE_IMAGE_TOOL_NAME);
	});

	it("is an ordinary direct tool when no eval tool is registered", async () => {
		const harness = await makeHarness({ withEval: false });
		harness.session.setActiveToolsByName(["read", GENERATE_IMAGE_TOOL_NAME]);

		expect(harness.session.getActiveToolNames()).toContain(GENERATE_IMAGE_TOOL_NAME);
		expect(harness.session.systemPrompt).not.toContain(EVAL_HINT);
		expect(harness.agent.removedToolHints[GENERATE_IMAGE_TOOL_NAME]).toBeUndefined();
	});
});
