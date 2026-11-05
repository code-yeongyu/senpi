import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { DispatchRequest } from "../../src/core/extensions/builtin/permission-system/dispatch.ts";
import { createDispatchAuthorizer } from "../../src/core/extensions/builtin/permission-system/dispatch-policy.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import type { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const allowAll = { dispatchDecision: () => ({ action: "allow" }) } as unknown as PermissionService;

function authorizer() {
	return createDispatchAuthorizer(
		{ getAllTools: () => [] },
		() => ({ service: allowAll, parsers: createBuiltinParserRegistry(), preset: null, setupError: null }),
		async () => undefined,
	);
}

async function runner(sessionManager: SessionManager | undefined): Promise<ExtensionRunner> {
	const extensions = await createTestExtensionsResult([]);
	return new ExtensionRunner(
		extensions.extensions,
		extensions.runtime,
		process.cwd(),
		sessionManager,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
		extensions.eventBus,
	);
}

const request: DispatchRequest = {
	toolCallId: "call-1",
	toolName: "bash",
	input: { command: "echo hi" },
	identity: { owner: {}, metadata: "bash" },
};

describe("nested dispatch policy on a runtime with no session (#5243)", () => {
	it("decides a nested dispatch from a context with no session manager", async () => {
		// Given a context from a runner built without a session manager.
		const context = (await runner(undefined)).createContext();
		// When a nested dispatch asks for its policy.
		const policy = authorizer().policy(request, context);
		// Then it resolves, with the runtime's empty session id in its fingerprint.
		expect(policy.action).toBe("allow");
		expect(JSON.parse(policy.fingerprint)[0]).toBe("");
	});

	it("keeps the session id in a session's fingerprint", async () => {
		const sessionManager = SessionManager.inMemory(process.cwd());
		const policy = authorizer().policy(request, (await runner(sessionManager)).createContext());
		expect(JSON.parse(policy.fingerprint)[0]).toBe(sessionManager.getSessionId());
	});
});
