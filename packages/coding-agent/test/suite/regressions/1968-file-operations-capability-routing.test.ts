import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildFileOperationsTuning,
	resolveFileMutationRouting,
} from "../../../src/core/extensions/builtin/prompt-preset/file-operations.ts";
import { resolvePreset } from "../../../src/core/extensions/builtin/prompt-preset/presets.ts";

// #1968: the "## File operations" block must name the edit verb the session
// actually has. It used to be emitted from preset identity, so a Grok 4.5 user
// - whose session can never activate apply_patch - was told to route every edit
// through it, and so was any GPT preset pinned onto an API that cannot carry
// the tool.

/** Every tool this block is allowed to name, as it names them: inside backticks. */
const TOOL_VOCABULARY = ["apply_patch", "edit", "write", "read", "grep"] as const;

const PATCH_SESSION = ["read", "bash", "grep", "apply_patch"];
const EDIT_SESSION = ["read", "bash", "grep", "edit", "write"];

function createModel(id: string, provider: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

/** Tool names the rendered text actually routes to, read back out of the prose. */
function toolsNamedIn(text: string): string[] {
	return TOOL_VOCABULARY.filter((name) => text.includes(`\`${name}\``));
}

describe("file mutation routing", () => {
	it.each([
		{ session: PATCH_SESSION, mode: "apply-patch", tools: ["apply_patch"] },
		{ session: EDIT_SESSION, mode: "edit-write", tools: ["edit", "write"] },
		{ session: ["read", "bash", "write"], mode: "edit-write", tools: ["write"] },
		{ session: ["read", "bash"], mode: "none", tools: [] },
		{ session: [], mode: "none", tools: [] },
	])("resolves $mode for $session", ({ session, mode, tools }) => {
		expect(resolveFileMutationRouting(session)).toEqual({ mode, tools });
	});

	it("never names a tool the session does not have", () => {
		for (const session of [PATCH_SESSION, EDIT_SESSION, ["read"], ["bash"], []]) {
			const rendered = buildFileOperationsTuning({ toolNames: session });
			expect(toolsNamedIn(rendered)).toEqual(toolsNamedIn(rendered).filter((name) => session.includes(name)));
		}
	});

	it("keeps the shell-mutation guard in every branch that routes an edit", () => {
		for (const session of [PATCH_SESSION, EDIT_SESSION]) {
			const rendered = buildFileOperationsTuning({ toolNames: session });
			for (const guard of ["cat >", "sed -i", "awk -i", "python"]) {
				expect(rendered).toContain(guard);
			}
		}
	});

	it("carries the apply_patch re-read guard only where apply_patch exists", () => {
		expect(buildFileOperationsTuning({ toolNames: PATCH_SESSION }).toLowerCase()).toContain("do not re-read");
		expect(buildFileOperationsTuning({ toolNames: EDIT_SESSION }).toLowerCase()).not.toContain("re-read");
	});
});

describe("rendered preset prompts", () => {
	it.each([
		{
			label: "GPT preset on an API that carries apply_patch",
			model: createModel("codex/gpt-6-astra", "gateway", "openai-completions"),
			preset: "gpt-6-astra",
			session: PATCH_SESSION,
		},
		{
			label: "GPT preset on an API that cannot carry apply_patch",
			model: createModel("codex/gpt-6-astra", "gateway", "anthropic-messages"),
			preset: "gpt-6-astra",
			session: EDIT_SESSION,
		},
		{
			label: "Grok 4.5, where apply_patch can never activate",
			model: createModel("grok-4.5", "xai", "openai-completions"),
			preset: "grok-4.5",
			session: EDIT_SESSION,
		},
		{
			label: "GPT-5.5 on a tuning-section preset without apply_patch",
			model: createModel("gpt-5.5", "openai", "anthropic-messages"),
			preset: "gpt-5.5",
			session: EDIT_SESSION,
		},
	])("$label never names an absent tool", ({ model, preset, session }) => {
		const resolved = resolvePreset(model, { promptPreset: "auto" }, { selectedTools: session });

		expect(resolved?.name).toBe(preset);
		const absent = TOOL_VOCABULARY.filter((name) => !session.includes(name));
		for (const name of absent) {
			expect(resolved?.prompt).not.toContain(`\`${name}\``);
		}
	});
});
