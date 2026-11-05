import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { DispatchRequest } from "../../src/core/extensions/builtin/permission-system/dispatch.ts";
import { createDispatchAuthorizer } from "../../src/core/extensions/builtin/permission-system/dispatch-policy.ts";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type { Request } from "../../src/core/extensions/builtin/permission-system/types.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

// One service shared by several sessions, as on a runtime that serves more than one scope.
function sharedService(): PermissionService {
	return new PermissionService([{ permission: "*", pattern: "*", action: "ask" }], [], createLocalEventEmitter());
}

function echo(id: string, sessionID: string): Request {
	return { id, sessionID, permission: "bash", patterns: ["echo hi"], always: ["echo *"], metadata: {} };
}

async function answerAlways(service: PermissionService, request: Request): Promise<void> {
	const pending = service.ask(request);
	service.reply({ requestID: request.id, reply: "always" });
	await pending;
}

function pendingIds(service: PermissionService): string[] {
	return service.list().map((request) => request.id);
}

describe("approvals are scoped per session (S16d)", () => {
	it("MULTI: an Always answer in one session does not approve the same call in a concurrent session", async () => {
		// Given session A answered Always for `echo *` on a service it shares with session B.
		const service = sharedService();
		await answerAlways(service, echo("a1", "A"));

		// When B makes the same call.
		const b1 = service.ask(echo("b1", "B"));

		// Then B is asked; A's answer did not approve it.
		expect(pendingIds(service)).toEqual(["b1"]);
		service.reply({ requestID: "b1", reply: "reject" });
		await expect(b1).rejects.toThrow();
		// And A's own answer still covers A's next call without asking.
		await service.ask(echo("a2", "A"));
		expect(pendingIds(service)).toEqual([]);
	});

	it("MULTI: a decision reads only the asking session's answers", async () => {
		const service = sharedService();
		await answerAlways(service, echo("a1", "A"));

		expect(service.dispatchDecision("bash", "echo hi", {}, "A").action).toBe("allow");
		expect(service.dispatchDecision("bash", "echo hi", {}, "B").action).toBe("ask");
	});

	it("MULTI: an Always reply settles only its own session's pending requests", async () => {
		// Given A and B each have the same call pending, and A has a second one.
		const service = sharedService();
		const a1 = service.ask(echo("a1", "A"));
		const b1 = service.ask(echo("b1", "B"));
		const a2 = service.ask(echo("a2", "A"));
		expect(pendingIds(service)).toEqual(["a1", "b1", "a2"]);

		// When A answers Always.
		service.reply({ requestID: "a1", reply: "always" });
		await Promise.all([a1, a2]);

		// Then A's covered request settles and B's stays pending; B's rejection leaves A alone.
		expect(pendingIds(service)).toEqual(["b1"]);
		const a3 = service.ask({ ...echo("a3", "A"), patterns: ["ls"], always: ["ls"] });
		service.reply({ requestID: "b1", reply: "reject" });
		await expect(b1).rejects.toThrow();
		expect(pendingIds(service)).toEqual(["a3"]);
		service.reply({ requestID: "a3", reply: "once" });
		await a3;
	});

	it("MULTI: the nested dispatch fence decides each session by its own answers", async () => {
		// Given two sessions served by one service, and an Always answer in the first.
		const service = sharedService();
		const extensions = await createTestExtensionsResult([]);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const contextOf = (sessionManager: SessionManager) =>
			new ExtensionRunner(
				extensions.extensions,
				extensions.runtime,
				process.cwd(),
				sessionManager,
				modelRegistry,
				extensions.eventBus,
			).createContext();
		const first = SessionManager.inMemory(process.cwd());
		const second = SessionManager.inMemory(process.cwd());
		await answerAlways(service, echo("a1", first.getSessionId()));
		const authorizer = createDispatchAuthorizer(
			{ getAllTools: () => [] },
			() => ({ service, parsers: createBuiltinParserRegistry(), preset: null, setupError: null }),
			async () => undefined,
		);
		const request: DispatchRequest = {
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "echo hi" },
			identity: { owner: {}, metadata: "bash" },
		};

		// Then the fence allows the first session's nested call and sends the second's to its own ask.
		expect(authorizer.policy(request, contextOf(first)).action).toBe("allow");
		expect(authorizer.policy(request, contextOf(second)).action).toBe("ask");
	});
});
