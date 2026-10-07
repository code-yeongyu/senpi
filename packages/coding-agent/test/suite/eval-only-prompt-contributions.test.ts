import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

/**
 * A tool withheld by the eval-only policy is still callable as `tool.<name>(...)`,
 * so its guidelines still apply and must survive the withholding. Its snippet must
 * NOT: snippets render as the prompt's tool list, which advertises what the model
 * may call directly, and a withheld tool is exactly what it may not.
 */

/**
 * A tool name that collides with a real builtin is silently won by the builtin, so
 * the probe tool uses its own name and the policy is armed over that name directly.
 */
const PROBE_TOOL = "policy_probe";
const GUIDELINE = "Inspect POLICY_PROBE_* environment variables for probe details.";
const SNIPPET = "policy-probe snippet";

async function createProbeHarness(): Promise<Harness> {
	const extensionFactory: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "eval",
			label: "Eval",
			description: "Evaluate code",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
		});
		pi.registerTool({
			name: PROBE_TOOL,
			label: "Policy probe",
			description: "Probe tool withheld by the policy",
			promptSnippet: SNIPPET,
			promptGuidelines: [GUIDELINE],
			parameters: Type.Object({ command: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
		});
	};
	const harness = await createHarness({
		extensionFactories: [extensionFactory],
		evalOnlyToolNames: [PROBE_TOOL],
	});
	return harness;
}

describe("eval-only policy prompt contributions", () => {
	it("keeps a withheld tool's guidance in the system prompt", async () => {
		const harness = await createProbeHarness();
		try {
			harness.session.setActiveToolsByName(["read", PROBE_TOOL, "eval"]);

			expect(harness.session.getActiveToolNames()).not.toContain(PROBE_TOOL);
			expect(harness.session.systemPrompt).toContain(GUIDELINE);
			expect(harness.session.systemPrompt).not.toContain(SNIPPET);
		} finally {
			harness.cleanup();
		}
	});

	it("still keeps the withheld tool out of the model-visible tool list", async () => {
		const harness = await createProbeHarness();
		try {
			harness.session.setActiveToolsByName(["read", PROBE_TOOL, "eval"]);

			// The guidance survives, but the tool must not be advertised as directly callable.
			expect(harness.session.systemPrompt).toContain(GUIDELINE);
			expect(harness.session.systemPrompt).not.toContain(SNIPPET);
			expect(harness.session.getActiveToolNames()).not.toContain(PROBE_TOOL);
			expect(harness.session.getRegisteredTool(PROBE_TOOL)).toBeTruthy();
		} finally {
			harness.cleanup();
		}
	});
});
