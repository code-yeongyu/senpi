import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import { localBridgeConnection } from "../src/kernels/js/local-module-loader.ts";

// Regression: session-manager computed localRoots/artifactsDir only AFTER the
// `language === "js"` early return, so py/rb/jl kernels received them on their
// connection and the JS kernel received neither. js cells then rejected every
// local:// path with "Protocol paths are not supported by write()", even though
// the JS prelude documents local:// as the session local root.
const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v20" } },
	py: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

describe("codemode session manager JS local roots", () => {
	let manager: CodemodeSessionManager | undefined;
	let dir = "";

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("Given artifactsDir when a js cell writes a local:// path then it resolves under <artifactsDir>/local", async () => {
		// Given: a session manager configured exactly like the extension runtime,
		// with an artifacts directory but no explicit localRoots.
		dir = mkdtempSync(join(tmpdir(), "codemode-js-local-"));
		const artifactsDir = join(dir, "artifacts");
		manager = await createCodemodeSessionManager({
			sessionId: "s",
			cwd: dir,
			settings: defaultCodemodeSettings,
			availability,
			artifactsDir,
			executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			complete: async () => {
				throw new Error("completion is not exercised in this test");
			},
		});

		// When
		const kernel = await manager.getKernel("js", () => {});
		const result = await kernel.run({
			cellId: "c1",
			code: 'return await write("local://f.txt", "x")',
			timeoutMs: 10_000,
		});

		// Then
		if (!result.ok) throw new Error(`js local:// write failed: ${result.error.message}`);
		expect(result.valueRepr).toBe(JSON.stringify(join(artifactsDir, "local", "f.txt")));
		expect(await readFile(join(artifactsDir, "local", "f.txt"), "utf8")).toBe("x");
	});

	it("Given explicit localRoots when a js cell reads a local:// path then it resolves under that root", async () => {
		// Given: an explicit local root that must win over the artifacts fallback.
		dir = mkdtempSync(join(tmpdir(), "codemode-js-local-explicit-"));
		const localRoot = join(dir, "explicit-root");
		manager = await createCodemodeSessionManager({
			sessionId: "s",
			cwd: dir,
			settings: defaultCodemodeSettings,
			availability,
			localRoots: { local: localRoot },
			artifactsDir: join(dir, "artifacts"),
			executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			complete: async () => {
				throw new Error("completion is not exercised in this test");
			},
		});

		// When
		const kernel = await manager.getKernel("js", () => {});
		const result = await kernel.run({
			cellId: "c1",
			code: 'await write("local://notes.md", "hi"); return await read("local://notes.md")',
			timeoutMs: 10_000,
		});

		// Then
		if (!result.ok) throw new Error(`js local:// round trip failed: ${result.error.message}`);
		expect(result.valueRepr).toBe(JSON.stringify("hi"));
		expect(await readFile(join(localRoot, "notes.md"), "utf8")).toBe("hi");
	});
});

describe("localBridgeConnection", () => {
	it("Given localRoots and artifactsDir when the worker init connection is built then both are carried", () => {
		// Given / When
		const connection = localBridgeConnection({
			cwd: "/tmp/cwd",
			localRoots: { local: "/tmp/roots/local" },
			artifactsDir: "/tmp/artifacts",
		});

		// Then
		expect(connection).toMatchObject({
			localRoots: { local: "/tmp/roots/local" },
			artifactsDir: "/tmp/artifacts",
		});
	});
});
