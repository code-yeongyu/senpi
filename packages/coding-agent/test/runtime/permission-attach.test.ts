import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

interface Flags {
	readonly permission?: string;
	readonly preset?: string;
}

async function createSessionlessRuntimes(flags: Flags, count: number): Promise<ExtensionRunner[]> {
	const dir = mkdtempSync(join(tmpdir(), "pi-rt6-permission-attach-"));
	disposers.push(() => rmSync(dir, { recursive: true, force: true }));
	const extensions = await createTestExtensionsResult([permissionSystemExtension], dir);
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runners = Array.from(
		{ length: count },
		() =>
			new ExtensionRunner(
				extensions.extensions,
				extensions.runtime,
				dir,
				SessionManager.inMemory(dir),
				modelRegistry,
				extensions.eventBus,
			),
	);
	if (flags.permission !== undefined) runners[0]?.setFlagValue("permission", flags.permission);
	if (flags.preset !== undefined) runners[0]?.setFlagValue("permission-preset", flags.preset);
	return runners;
}

async function createSessionlessRuntime(flags: Flags): Promise<ExtensionRunner> {
	const [runner] = await createSessionlessRuntimes(flags, 1);
	if (runner === undefined) throw new Error("no runtime");
	return runner;
}

async function runtimeWithoutSessionManager(flags: Flags): Promise<ExtensionRunner> {
	const dir = mkdtempSync(join(tmpdir(), "pi-rt6-permission-runtime-"));
	disposers.push(() => rmSync(dir, { recursive: true, force: true }));
	const extensions = await createTestExtensionsResult([permissionSystemExtension], dir);
	const runner = new ExtensionRunner(
		extensions.extensions,
		extensions.runtime,
		dir,
		undefined,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
		extensions.eventBus,
	);
	if (flags.permission !== undefined) runner.setFlagValue("permission", flags.permission);
	if (flags.preset !== undefined) runner.setFlagValue("permission-preset", flags.preset);
	return runner;
}

function runBash(runner: ExtensionRunner, command: string) {
	return runner.emitToolCall({ type: "tool_call", toolName: "bash", input: { command }, toolCallId: "call-1" });
}

describe("permission checks attach without a session (RT6)", () => {
	it("blocks a call the rules deny", async () => {
		// Given a sessionless runtime whose rules deny bash.
		const runner = await createSessionlessRuntime({ permission: "bash=deny" });
		// When a tool call arrives.
		const result = await runBash(runner, "echo should-not-run");
		// Then the rules refuse it instead of letting it through unchecked.
		expect(result).toMatchObject({ block: true });
	});

	it("lets a call the rules allow run", async () => {
		const runner = await createSessionlessRuntime({ permission: "bash=allow" });
		expect(await runBash(runner, "echo hello")).toBeUndefined();
	});

	it.each([
		["an ask rule under the default preset", { permission: "bash=ask" }],
		["the ask preset", { preset: "ask" }],
		["the read-only preset", { preset: "read-only" }],
	] as const)("settles %s with no UI the way a session with no UI does", async (_label, flags) => {
		// Given the same rules on a session and on a runtime with no session, both without a UI.
		const session = await createSessionlessRuntime(flags);
		await session.emit({ type: "session_start", reason: "startup" });
		const sessionless = await createSessionlessRuntime(flags);
		// Then a call that needs approval gets the same answer on both.
		expect(await runBash(sessionless, "echo needs-approval")).toEqual(await runBash(session, "echo needs-approval"));
	});

	it("does not attach again at a tool call once session_start attached the context", async () => {
		// Given a session whose session_start attached the rules.
		const runner = await createSessionlessRuntime({ permission: "bash=allow" });
		const loads = vi.spyOn(SettingsManager, "create");
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(loads).toHaveBeenCalledTimes(1);
		// When tool calls arrive.
		await runBash(runner, "echo one");
		await runBash(runner, "echo two");
		// Then the first-use attach never runs on the session path.
		expect(loads).toHaveBeenCalledTimes(1);
	});

	it("attaches each context once", async () => {
		// Given one extension load seen through two contexts with no session start.
		const [first, second] = await createSessionlessRuntimes({ permission: "bash=deny" }, 2);
		if (first === undefined || second === undefined) throw new Error("no runtimes");
		const loads = vi.spyOn(SettingsManager, "create");
		// When each context sees tool calls.
		expect(await runBash(first, "echo one")).toMatchObject({ block: true });
		expect(await runBash(first, "echo two")).toMatchObject({ block: true });
		expect(await runBash(second, "echo three")).toMatchObject({ block: true });
		expect(await runBash(second, "echo four")).toMatchObject({ block: true });
		// Then each context attached exactly once.
		expect(loads).toHaveBeenCalledTimes(2);
	});

	it("attaches once on a runtime whose contexts have no session manager", async () => {
		// Given a runner built without a session manager, whose contexts carry none.
		const runner = await runtimeWithoutSessionManager({ permission: "bash=deny" });
		const loads = vi.spyOn(SettingsManager, "create");
		const added = vi.spyOn(WeakSet.prototype, "add");
		// When tool calls arrive.
		expect(await runBash(runner, "echo one")).toMatchObject({ block: true });
		expect(await runBash(runner, "echo two")).toMatchObject({ block: true });
		expect(await runBash(runner, "echo three")).toMatchObject({ block: true });
		// Then the runtime attached once, and no undefined key reached a WeakSet.
		expect(loads).toHaveBeenCalledTimes(1);
		expect(added.mock.calls.some(([value]) => value === undefined)).toBe(false);
	});

	it("refuses every call on a runtime with no session manager when the preset is invalid", async () => {
		const runner = await runtimeWithoutSessionManager({ preset: "full-acess" });
		const result = await runBash(runner, "echo hello");
		expect(result).toMatchObject({ block: true });
		expect(JSON.stringify(result)).toContain("Permission setup failed");
	});

	it("refuses every call when the preset is invalid", async () => {
		const runner = await createSessionlessRuntime({ preset: "full-acess" });
		const result = await runBash(runner, "echo hello");
		expect(result).toMatchObject({ block: true });
		expect(JSON.stringify(result)).toContain("Permission setup failed");
	});
});
