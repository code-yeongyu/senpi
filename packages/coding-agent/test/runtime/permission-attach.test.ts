import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

interface Flags {
	readonly permission?: string;
	readonly preset?: string;
}

async function createSessionlessRuntime(flags: Flags): Promise<ExtensionRunner> {
	const dir = mkdtempSync(join(tmpdir(), "pi-rt6-permission-attach-"));
	disposers.push(() => rmSync(dir, { recursive: true, force: true }));
	const extensions = await createTestExtensionsResult([permissionSystemExtension], dir);
	const runner = new ExtensionRunner(
		extensions.extensions,
		extensions.runtime,
		dir,
		SessionManager.inMemory(dir),
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

	it("settles an ask with no UI the way a session with no UI does", async () => {
		// Given a rule that asks, and no UI to show a prompt.
		const runner = await createSessionlessRuntime({ permission: "bash=ask" });
		// Then the no-UI path refuses the call.
		expect(await runBash(runner, "echo needs-approval")).toMatchObject({ block: true });
	});

	it("refuses every call when the preset is invalid", async () => {
		const runner = await createSessionlessRuntime({ preset: "full-acess" });
		const result = await runBash(runner, "echo hello");
		expect(result).toMatchObject({ block: true });
		expect(JSON.stringify(result)).toContain("Permission setup failed");
	});
});
