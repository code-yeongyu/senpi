import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pickVariant } from "../../../src/core/extensions/builtin/ask-user/index.ts";
import gptApplyPatchExtension, {
	getApplyPatchWireMode,
} from "../../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import { resolvePresetName } from "../../../src/core/extensions/builtin/prompt-preset/presets.ts";
import { createHarness } from "../harness.ts";

const models = [
	["gpt-6-astra", "gpt-6-astra"],
	["codex/gpt-6-astra", "gpt-6-astra"],
	["openrouter/gpt-6-astra", "gpt-6-astra"],
	["opencode/gpt-5.6", "gpt-5.6"],
	["global.openai.gpt-6-astra", "gpt-6-astra"],
	["gateway:GPT_6_ASTRA", "gpt-6-astra"],
	["gateway/gpt6-astra", "gpt-6-astra"],
] as const;

// #1891: the preset and tool capability must agree for gateway-prefixed GPT ids.
it.each([
	["openai-completions", "json"],
	["openai-responses", "freeform"],
	["azure-openai-responses", "freeform"],
	["openai-codex-responses", "freeform"],
])("preserves the %s wire mode for prefixed models", (api, expected) => {
	for (const [id, preset] of models) {
		expect(resolvePresetName({ id, provider: "fixture" }, { promptPreset: "auto" })).toBe(preset);
		expect(getApplyPatchWireMode({ api, id })).toBe(expected);
	}
});

it.each([
	["openai-completions", "xgpt-5.6-proxy"],
	["openai-responses", "gateway/glm-5.3"],
	["openai-responses", "gateway/o1"],
	["anthropic-messages", "codex/gpt-6-astra"],
	["bedrock-converse-stream", "global.openai.gpt-6-astra"],
	["custom-api", "openrouter/gpt-5.6"],
])("keeps unsupported %s / %s on ordinary editing tools", (api, id) => {
	expect(getApplyPatchWireMode({ api, id })).toBe("none");
});

it.each(["openai-completions", "openai-responses"])(
	"activates, executes and restores tools across a prefixed GPT switch on %s",
	async (api) => {
		const harness = await createHarness({
			api,
			models: [{ id: "glm/glm-5.3" }, { id: "codex/gpt-6-astra" }],
			extensionFactories: [gptApplyPatchExtension],
		});
		try {
			await harness.session.bindExtensions({});
			expect(harness.session.getActiveToolNames()).not.toContain("apply_patch");
			await harness.session.setModel(harness.models[1]!);
			expect(harness.session.getActiveToolNames()).toContain("apply_patch");
			expect(harness.session.getActiveToolNames()).not.toContain("edit");
			expect(Boolean(harness.session.getToolDefinition("apply_patch")?.freeform)).toBe(api === "openai-responses");
			const file = join(harness.tempDir, "value.txt");
			await writeFile(file, "before\n");
			// Exercise the registered tool's lazy activation through the real session, not a stub.
			harness.session.setActiveToolsByName(["read"]);
			await harness.session.executeTool(
				"apply_patch",
				{ input: "*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch" },
				{ activateInactiveTool: true },
			);
			expect(await readFile(file, "utf8")).toBe("after\n");
			await harness.session.setModel(harness.models[0]);
			expect(harness.session.getActiveToolNames()).not.toContain("apply_patch");
			expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["edit", "write"]));
		} finally {
			harness.cleanup();
		}
	},
);

// ask-user picks its tool family off the same predicate, so widening the gate had to move
// prefixed ids onto request_user_input alongside their bare counterparts, not leave them split.
it.each(["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"])(
	"gives prefixed and bare GPT ids the same ask-user family on %s",
	(api) => {
		for (const [id] of models) {
			expect(pickVariant({ api, id })).toBe("codex");
		}
		expect(pickVariant({ api, id: "gateway/glm-5.3" })).toBe("claude");
		expect(pickVariant({ api: "anthropic-messages", id: "codex/gpt-6-astra" })).toBe("claude");
		expect(pickVariant(undefined)).toBe("claude");
	},
);
