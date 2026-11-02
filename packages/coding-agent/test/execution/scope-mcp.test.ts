// Brain/hand split plan row S16c (Z2.ISO.c): one MCP extension instance serving several execution scopes keeps
// each scope's attach and control inventory; a scope attached later does not take over an earlier one's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { MCP_CONTROL_INVENTORY_REQUEST_EVENT } from "../../src/core/extensions/builtin/mcp/control-inventory.ts";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

let dir = "";
let service: McpService | undefined;
afterEach(async () => {
	await service?.dispose("quit");
	service = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

// One loaded MCP extension (one runtime) and a runner per scope, each with its own session.
async function runtimeWithScopes(): Promise<{
	readonly scopes: readonly { readonly runner: ExtensionRunner; readonly sessionId: string }[];
	readonly answered: (sessionId: string) => boolean;
}> {
	dir = mkdtempSync(join(tmpdir(), "scope-mcp-"));
	service = new McpService();
	const extensions = await createTestExtensionsResult([createMcpExtension(service)], dir);
	const bus = extensions.eventBus;
	if (bus === undefined) throw new Error("the test extensions have no event bus");
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const scopes = ["A", "B"].map(() => {
		const sessionManager = SessionManager.inMemory(dir);
		const runner = new ExtensionRunner(
			extensions.extensions,
			extensions.runtime,
			dir,
			sessionManager,
			modelRegistry,
			extensions.eventBus,
		);
		return { runner, sessionId: sessionManager.getSessionId() };
	});
	const answered = (sessionId: string): boolean => {
		let responded = false;
		bus.emit(MCP_CONTROL_INVENTORY_REQUEST_EVENT, {
			sessionId,
			respond: () => {
				responded = true;
			},
		});
		return responded;
	};
	return { scopes, answered };
}

function firstToolCall(runner: ExtensionRunner, id: string) {
	return runner.emitToolCall({ type: "tool_call", toolName: "read", input: { path: "a.txt" }, toolCallId: id });
}

describe("MCP state is scoped per execution scope (S16c)", () => {
	it("MULTI: every scope a runtime attached keeps answering its own control inventory", async () => {
		// Given a runtime whose scopes A and B each attached at their first tool call, A first.
		const { scopes, answered } = await runtimeWithScopes();
		const [a, b] = scopes;
		if (a === undefined || b === undefined) throw new Error("two scopes expected");
		await firstToolCall(a.runner, "a-1");
		await firstToolCall(b.runner, "b-1");
		await service?.whenAttachSettled();

		// When each scope asks for its inventory.
		// Then both are answered: B attaching later did not take A's place.
		expect(answered(a.sessionId)).toBe(true);
		expect(answered(b.sessionId)).toBe(true);
		expect(answered("not-attached")).toBe(false);
	});

	it("keeps one session's inventory after a session_start, as before scopes existed", async () => {
		// Given scope A attached at its first tool call, then scope B's session started.
		const { scopes, answered } = await runtimeWithScopes();
		const [a, b] = scopes;
		if (a === undefined || b === undefined) throw new Error("two scopes expected");
		await firstToolCall(a.runner, "a-1");
		await b.runner.emit({ type: "session_start", reason: "startup" });
		await service?.whenAttachSettled();

		// Then only the started session answers.
		expect(answered(b.sessionId)).toBe(true);
		expect(answered(a.sessionId)).toBe(false);
	});
});
