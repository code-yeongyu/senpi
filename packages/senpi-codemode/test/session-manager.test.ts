import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";

const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v20" } },
	py: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

function textOf(messages: KernelToHostMessage[]): string {
	return messages
		.filter((message): message is Extract<KernelToHostMessage, { type: "text" }> => message.type === "text")
		.map((message) => message.data)
		.join("");
}

describe("codemode session manager kernel reuse", () => {
	let manager: CodemodeSessionManager | undefined;
	let dir = "";

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	// Regression: a persistent kernel reused across cells must stream each cell's
	// output to that cell's onMessage. Before the fix, getKernel returned the
	// existing kernel without rebinding onMessage, so the 2nd cell's print()
	// output was misrouted to the 1st cell's (already-finished) handler.
	it("rebinds onMessage per cell for a reused JS kernel", async () => {
		dir = mkdtempSync(join(tmpdir(), "codemode-sm-"));
		manager = await createCodemodeSessionManager({
			sessionId: "s",
			cwd: dir,
			settings: defaultCodemodeSettings,
			availability,
			executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			complete: async () => {
				throw new Error("completion is not exercised in this test");
			},
		});

		const seen1: KernelToHostMessage[] = [];
		const seen2: KernelToHostMessage[] = [];

		const kernel1 = await manager.getKernel("js", (message) => seen1.push(message));
		await kernel1.run({ cellId: "c1", code: 'print("first")', timeoutMs: 5000 });

		const kernel2 = await manager.getKernel("js", (message) => seen2.push(message));
		await kernel2.run({ cellId: "c2", code: 'print("second")', timeoutMs: 5000 });

		expect(kernel2).toBe(kernel1);
		expect(textOf(seen2)).toContain("second");
		expect(textOf(seen2)).not.toContain("first");
		expect(textOf(seen1)).not.toContain("second");
	});
});
