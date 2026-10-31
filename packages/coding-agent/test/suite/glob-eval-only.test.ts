import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createHarness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

const withEval: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "eval",
		label: "Eval",
		description: "Evaluate code",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
	});
};

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("glob is reachable only inside eval (#3330)", () => {
	it("is never a top-level tool, with or without eval", async () => {
		for (const extensionFactories of [[withEval], []]) {
			const harness = await createHarness({ extensionFactories });
			try {
				expect(harness.session.getAllTools().map(({ name }) => name)).toContain("glob");
				expect(harness.session.getActiveToolNames()).not.toContain("glob");
			} finally {
				harness.cleanup();
			}
		}
	});

	it("finds files by glob through tool.glob inside eval", async () => {
		dir = mkdtempSync(join(tmpdir(), "senpi-glob-"));
		mkdirSync(join(dir, "nested"));
		writeFileSync(join(dir, "nested", "checkpoint-a.md"), "a");
		writeFileSync(join(dir, "other.txt"), "b");
		const harness = await createHarness({ extensionFactories: [withEval] });
		try {
			const result = await harness.session.executeTool("glob", { pattern: "**/*checkpoint*", path: dir });
			expect(textOf(result)).toContain("nested/checkpoint-a.md");
			expect(textOf(result)).not.toContain("other.txt");
			expect(harness.session.getActiveToolNames()).not.toContain("glob");
		} finally {
			harness.cleanup();
		}
	});

	it("tells the model to call tool.glob inside eval", async () => {
		const harness = await createHarness({ extensionFactories: [withEval] });
		try {
			expect(harness.session.systemPrompt).toContain('tool.glob({ pattern: "...", path: "..." })');
		} finally {
			harness.cleanup();
		}
	});
});
