// Brain/hand split plan row S16b (Z2.ISO.b): one codemode runtime serving several execution scopes gives each
// scope its own kernels, so a cell in one scope never sees, reaches or outlives another scope's state.
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { ScopedKernelManagers } from "../src/extension/scope-kernels.ts";
import {
	type CodemodeSessionManager,
	type CreateCodemodeSessionManagerOptions,
	createCodemodeSessionManager,
} from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";

const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v24" } },
	py: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

let dir = "";
let scoped: ScopedKernelManagers | undefined;
afterEach(async () => {
	await scoped?.dispose();
	scoped = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

function baseOptions(): CreateCodemodeSessionManagerOptions {
	dir = mkdtempSync(join(tmpdir(), "codemode-scope-kernels-"));
	return {
		sessionId: "runtime",
		cwd: dir,
		settings: defaultCodemodeSettings,
		availability,
		artifactsDir: join(dir, "artifacts"),
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => {
			throw new Error("completion is not exercised in this test");
		},
	};
}

async function runJs(manager: CodemodeSessionManager, cellId: string, code: string): Promise<string | undefined> {
	const kernel = await manager.getKernel("js", () => {});
	const result = await kernel.run({ cellId, code, timeoutMs: 10_000 });
	if (!result.ok) throw new Error(`cell ${cellId} failed: ${result.error.message}`);
	return result.valueRepr;
}

describe("eval kernels are scoped per execution scope (S16b)", () => {
	it("MULTI: one scope's globals are invisible to another scope on the same runtime", async () => {
		// Given scopes A and B on one runtime, and A sets a global.
		scoped = new ScopedKernelManagers(baseOptions());
		const a = await scoped.forScope({ id: "A", root: "" });
		const b = await scoped.forScope({ id: "B", root: "" });
		await runJs(a, "a1", 'globalThis.secret = "from A"; return 1');

		// When B reads the same global, and A reads it again.
		const seenByB = await runJs(b, "b1", "return typeof globalThis.secret");
		const seenByA = await runJs(a, "a2", "return globalThis.secret");

		// Then B sees nothing and A keeps its own state.
		expect(seenByB).toBe(JSON.stringify("undefined"));
		expect(seenByA).toBe(JSON.stringify("from A"));
	});

	it("MULTI: releasing one scope closes its kernels and leaves another scope's running", async () => {
		// Given both scopes hold live state.
		scoped = new ScopedKernelManagers(baseOptions());
		const a = await scoped.forScope({ id: "A", root: "" });
		const b = await scoped.forScope({ id: "B", root: "" });
		await runJs(a, "a1", "globalThis.n = 1; return 1");
		await runJs(b, "b1", "globalThis.n = 2; return 2");

		// When scope A is released.
		await scoped.releaseScope("A");

		// Then A's manager is gone, B's state is intact, and A starts fresh when it returns.
		await expect(a.getKernel("js", () => {})).rejects.toThrow("disposed");
		expect(await runJs(b, "b2", "return globalThis.n")).toBe("2");
		const again = await scoped.forScope({ id: "A", root: "" });
		expect(await runJs(again, "a2", "return typeof globalThis.n")).toBe(JSON.stringify("undefined"));
	});

	it("MULTI: each scope writes local:// into its own root", async () => {
		// Given scopes A and B each write the same local:// path.
		scoped = new ScopedKernelManagers(baseOptions());
		const a = await scoped.forScope({ id: "A", root: "" });
		const b = await scoped.forScope({ id: "B", root: "" });
		const pathA = String(JSON.parse((await runJs(a, "a1", 'return await write("local://note.txt", "A")')) ?? '""'));
		const pathB = String(JSON.parse((await runJs(b, "b1", 'return await write("local://note.txt", "B")')) ?? '""'));

		// Then the files differ and neither overwrote the other.
		expect(pathA).not.toBe(pathB);
		expect(await readFile(pathA, "utf8")).toBe("A");
		expect(await readFile(pathB, "utf8")).toBe("B");
	});

	it("starts nothing for a scope that never asks, and reuses one manager per scope", async () => {
		// Given a runtime that counts the managers it creates.
		const created: string[] = [];
		scoped = new ScopedKernelManagers(baseOptions(), async (options) => {
			created.push(options.sessionId);
			return await createCodemodeSessionManager(options);
		});

		// When scope A asks twice and B never asks.
		const first = await scoped.forScope({ id: "A", root: "" });
		const second = await scoped.forScope({ id: "A", root: "" });

		// Then A has one manager, with the scope as its session, and B has none.
		expect(second).toBe(first);
		expect(created).toEqual(["A"]);
	});
});
