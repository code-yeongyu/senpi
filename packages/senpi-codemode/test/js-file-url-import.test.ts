import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";

// senpi#4111: a JS cell rejected `import(pathToFileURL(p).href)` with "Unsupported module protocol"
// because the loader routed every `scheme://` specifier through the registered local roots, and `file`
// is never one of them. The same module imported by its absolute path loaded fine.
const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v20" } },
	py: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

describe("codemode JS file:// module imports (senpi#4111)", () => {
	let manager: CodemodeSessionManager | undefined;
	let dir = "";

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	async function runCell(code: string) {
		dir = mkdtempSync(join(tmpdir(), "codemode-js-file-url-"));
		writeFileSync(join(dir, "fixture.mjs"), "export const answer = 42;\n");
		manager = await createCodemodeSessionManager({
			sessionId: "s",
			cwd: dir,
			settings: defaultCodemodeSettings,
			availability,
			artifactsDir: join(dir, "artifacts"),
			executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			complete: async () => {
				throw new Error("completion is not exercised in this test");
			},
		});
		const kernel = await manager.getKernel("js", () => {});
		return kernel.run({
			cellId: "c1",
			code: code.replaceAll("$FIXTURE_URL", pathToFileURL(join(dir, "fixture.mjs")).href),
			timeoutMs: 10_000,
		});
	}

	it("Given a file URL from pathToFileURL when a cell imports it dynamically then the module loads", async () => {
		// When
		const result = await runCell('const m = await import("$FIXTURE_URL"); return m.answer');

		// Then
		if (!result.ok) throw new Error(`file:// dynamic import failed: ${result.error.message}`);
		expect(result.valueRepr).toBe("42");
	});

	it("Given a file URL when a cell imports it statically then the module loads", async () => {
		// When
		const result = await runCell('import { answer } from "$FIXTURE_URL";\nreturn answer');

		// Then
		if (!result.ok) throw new Error(`file:// static import failed: ${result.error.message}`);
		expect(result.valueRepr).toBe("42");
	});

	it("Given a scheme with no registered root when a cell imports it then the loader still refuses it", async () => {
		// When
		const result = await runCell('return await import("nosuchroot://fixture.mjs")');

		// Then
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("Unsupported module protocol: nosuchroot://fixture.mjs");
	});
});
