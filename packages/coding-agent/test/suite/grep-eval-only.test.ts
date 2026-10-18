import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolExposure } from "../../src/core/extensions/types.ts";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createGrepToolDefinition } from "../../src/core/tools/grep.ts";
import { createPowerShellToolDefinition } from "../../src/core/tools/powershell.ts";
import { createHarness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

const PROBE_HINT = "tool.probe({ ... })";
const GREP_HINT = 'tool.grep({ pattern: "...", path: "..." })';
// The engine-backed grep always ends with the frozen footer; searched/elapsed vary per host.
const NO_MATCH_TEXT =
	/^No matches found\n\n\[grep: matches=0 files=0 searched=\d+ elapsedMs=\d+ engine=(?:native|rg) nextSkip=none\]$/;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

interface ProbeHarnessOptions {
	withEval?: boolean;
	withGrep?: boolean;
	registerOnStart?: boolean;
	evalOnlyToolNames?: string[];
	fileSettings?: boolean;
}

async function createProbeHarness(options: ProbeHarnessOptions = {}) {
	const extensionFactory: ExtensionFactory = (pi) => {
		if (options.withEval !== false) {
			pi.registerTool({
				name: "eval",
				label: "Eval",
				description: "Evaluate code",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
			});
		}
		const registerProbe = () =>
			pi.registerTool({
				name: "probe",
				label: "Probe",
				description: "Probe the system",
				exposure: "eval",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_id, params) => ({
					content: [{ type: "text", text: `probe-ran:${params.value}` }],
					details: {},
				}),
			});
		if (options.registerOnStart) {
			pi.on("session_start", registerProbe);
		} else {
			registerProbe();
		}
		if (options.withGrep) {
			// Explicit registration keeps this policy test independent of todo 6's builtin restoration.
			pi.registerTool(createGrepToolDefinition(process.cwd()));
		}
	};
	return {
		harness: await createHarness({
			extensionFactories: [extensionFactory],
			fileSettings: options.fileSettings,
			evalOnlyToolNames: options.evalOnlyToolNames,
		}),
	};
}

describe("default grep surface (#1678)", () => {
	it("lists builtin grep for codemode without exposing it directly when eval is registered", async () => {
		const { harness } = await createProbeHarness();
		try {
			expect(harness.session.getAllTools().map(({ name }) => name)).toContain("grep");
			expect(harness.session.getActiveToolNames()).not.toContain("grep");
			const result = await harness.session.executeTool("grep", { pattern: "x" });
			expect(textOf(result)).toMatch(NO_MATCH_TEXT);
			expect(harness.session.getActiveToolNames()).not.toContain("grep");
		} finally {
			harness.cleanup();
		}
	});

	it("activates builtin grep by default without eval", async () => {
		const { harness } = await createProbeHarness({ withEval: false });
		try {
			expect(harness.session.getActiveToolNames()).toContain("grep");
			expect(textOf(await harness.session.executeTool("grep", { pattern: "x" }))).toMatch(NO_MATCH_TEXT);
		} finally {
			harness.cleanup();
		}
	});
});

describe("policy", () => {
	it("withholds an eval-exposed extension tool while eval is present, but executes it", async () => {
		const { harness } = await createProbeHarness();
		try {
			harness.session.setActiveToolsByName(["read", "eval", "probe", "edit", "write"]);
			expect(harness.session.getActiveToolNames()).not.toContain("probe");
			const result = await harness.session.executeTool("probe", { value: "ok" }, { activateInactiveTool: true });
			expect(textOf(result)).toContain("probe-ran:ok");
			expect(harness.session.getActiveToolNames()).not.toContain("probe");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps an eval-exposed extension tool directly callable without eval", async () => {
		const { harness } = await createProbeHarness({ withEval: false });
		try {
			expect(harness.session.getActiveToolNames()).toContain("probe");
			harness.session.setActiveToolsByName(["read", "probe", "edit", "write"]);
			expect(harness.session.getActiveToolNames()).toContain("probe");
			const result = await harness.session.executeTool("probe", { value: "direct" });
			expect(textOf(result)).toContain("probe-ran:direct");
		} finally {
			harness.cleanup();
		}
	});

	it("publishes the eval redirect hint when armed", async () => {
		const { harness } = await createProbeHarness();
		try {
			harness.session.setActiveToolsByName(["read", "eval", "probe", "edit", "write"]);
			expect(harness.agent.removedToolHints.probe).toContain(PROBE_HINT);
			expect(harness.session.systemPrompt).toContain(PROBE_HINT);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps eval exposure withheld after reload", async () => {
		const { harness } = await createProbeHarness({ fileSettings: true });
		try {
			harness.session.setActiveToolsByName(["read", "eval", "probe", "edit", "write"]);
			await harness.session.reload();
			expect(harness.session.getActiveToolNames()).not.toContain("probe");
			expect(harness.agent.removedToolHints.probe).toContain(PROBE_HINT);
			expect(textOf(await harness.session.executeTool("probe", { value: "reloaded" }))).toContain(
				"probe-ran:reloaded",
			);
		} finally {
			harness.cleanup();
		}
	});

	it.each([true, false])("recomputes declared policy on dynamic registration with eval=%s", async (withEval) => {
		const { harness } = await createProbeHarness({ withEval, registerOnStart: true });
		try {
			expect(harness.session.getAllTools().map(({ name }) => name)).not.toContain("probe");
			await harness.session.bindExtensions({});
			expect(harness.session.getAllTools().map(({ name }) => name)).toContain("probe");
			expect(harness.session.getActiveToolNames().includes("probe")).toBe(!withEval);
			if (withEval) {
				expect(harness.agent.removedToolHints.probe).toContain(PROBE_HINT);
			} else {
				expect(harness.agent.removedToolHints.probe).toBeUndefined();
			}
			expect(textOf(await harness.session.executeTool("probe", { value: "dynamic" }))).toContain(
				"probe-ran:dynamic",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("lets an empty SDK override replace declared and fixed policy names across reload", async () => {
		const { harness } = await createProbeHarness({ evalOnlyToolNames: [], fileSettings: true });
		try {
			expect(harness.session.getActiveToolNames()).toContain("probe");
			expect(harness.session.getActiveToolNames()).toContain("bash");
			expect(harness.agent.removedToolHints.probe).toBeUndefined();
			await harness.session.reload();
			expect(harness.session.getActiveToolNames()).toContain("probe");
			expect(harness.session.getActiveToolNames()).toContain("bash");
			expect(harness.agent.removedToolHints.probe).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("ends the system prompt with dedicated grep guidance when grep and eval are registered", async () => {
		const { harness } = await createProbeHarness({ withGrep: true });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("grep");
			expect(harness.agent.removedToolHints.grep).toContain(GREP_HINT);
			// Pin the callable shape and suffix placement, not the surrounding prose.
			const lastParagraph = harness.session.systemPrompt.split("\n\n").at(-1);
			expect(lastParagraph).toContain(GREP_HINT);
			expect(lastParagraph).not.toContain(PROBE_HINT);
			expect(harness.session.systemPrompt).toContain(PROBE_HINT);
		} finally {
			harness.cleanup();
		}
	});

	it("omits eval-only grep guidance when eval is absent", async () => {
		const { harness } = await createProbeHarness({ withGrep: true, withEval: false });
		try {
			expect(harness.session.getActiveToolNames()).toContain("grep");
			expect(harness.session.systemPrompt).not.toContain(GREP_HINT);
			expect(harness.agent.removedToolHints.grep).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});

describe("normalize", () => {
	it("declares eval exposure on the builtin shell and grep definitions", () => {
		for (const definition of [
			createBashToolDefinition(process.cwd()),
			createPowerShellToolDefinition(process.cwd()),
			createGrepToolDefinition(process.cwd()),
		]) {
			expect(normalizeToolExposure(definition).exposure, definition.name).toBe("eval");
		}
	});

	it("passes eval exposure through and defaults lazy activation like direct tools", () => {
		expect(normalizeToolExposure({ exposure: "eval" })).toMatchObject({
			exposure: "eval",
			allowLazyActivation: true,
		});
	});
});
