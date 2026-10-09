import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

const managerPath = fileURLToPath(new URL("../src/extension/session-manager.ts", import.meta.url));
const settingsPath = fileURLToPath(new URL("../src/config/settings.ts", import.meta.url));

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// #2260: JSC (Bun) retains a closure's whole lexical environment, while V8 frees bindings the
// closure body never reads — so this regression must run under Bun against the real kernel and
// manager, spawned like packages/coding-agent/test/extensions/bun-extension-regressions.test.ts.
// Under vitest/Node the same WeakRef can pass even when the dispatcher still pins the first cell.
describe("kernel dispatcher first-cell pin (#2260)", () => {
	it("collects the settled first cell's listener once it is released", () => {
		const root = mkdtempSync(join(tmpdir(), "codemode-dispatch-pin-"));
		roots.push(root);
		execFileSync("bun", ["--eval", scenario()], { cwd: root, encoding: "utf8", timeout: 120_000 });
	});
});

function scenario(): string {
	return `
import assert from "node:assert/strict";
const managerPath = ${JSON.stringify(managerPath)};
const settingsPath = ${JSON.stringify(settingsPath)};
const { createCodemodeSessionManager } = await import(managerPath);
const { defaultCodemodeSettings } = await import(settingsPath);
const availability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v20" } },
	py: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};
const seen1 = [];
const seen2 = [];
function makePinnedListener() {
	const big = new ArrayBuffer(8 * 1024 * 1024);
	const onMessage = (message) => { seen1.push(message); if (big.byteLength < 0) seen1.push(message); };
	return { onMessage, ref: new WeakRef(big) };
}
let pinned = makePinnedListener();
const weakRef = pinned.ref;
const manager = await createCodemodeSessionManager({
	sessionId: "pin",
	cwd: process.cwd(),
	settings: defaultCodemodeSettings,
	availability,
	executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
	complete: async () => { throw new Error("completion is not exercised in this test"); },
});
// The first cell runs inside a nested async function: its frame (and the registers holding the
// listener argument) must die on return, or this scenario would pin the listener itself.
async function runFirstCell() {
	const kernel = await manager.getKernel("js", pinned.onMessage);
	const first = await kernel.run({
		cellId: "c1",
		code: 'print("first")',
		onMessage: pinned.onMessage,
		timeoutMs: 10_000,
	});
	assert.equal(first.ok, true);
	manager.releaseKernelListener?.("js", pinned.onMessage);
	return kernel;
}
try {
	const kernel = await runFirstCell();
	assert.ok(
		seen1.some((message) => message.type === "text" && String(message.data).includes("first")),
		"the first cell's output reaches its own listener",
	);
	const second = await kernel.run({
		cellId: "c2",
		code: 'print("second")',
		onMessage: (message) => { seen2.push(message); },
		timeoutMs: 10_000,
	});
	assert.equal(second.ok, true);
	assert.ok(
		seen2.some((message) => message.type === "text" && String(message.data).includes("second")),
		"the second cell's output reaches its own listener",
	);
	assert.ok(
		!seen2.some((message) => message.type === "text" && String(message.data).includes("first")),
		"the first cell's output is not re-attributed to the second cell",
	);
	pinned = undefined;
	for (let round = 0; round < 3; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		Bun.gc(true);
	}
	assert.equal(
		weakRef.deref(),
		undefined,
		"the settled first cell's listener (and the buffers it captured) must be collectable",
	);
} finally {
	await manager.dispose();
}
`;
}
