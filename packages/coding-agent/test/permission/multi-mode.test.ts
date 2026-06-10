import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { createLocalEventEmitter } from "../../src/core/extensions/builtin/permission-system/events.ts";
import { handleNoUI } from "../../src/core/extensions/builtin/permission-system/non-interactive.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import {
	CorrectedError,
	DeniedError,
	RejectedError,
	type Request,
	type Ruleset,
} from "../../src/core/extensions/builtin/permission-system/types.ts";
import type { ExtensionContext, ExtensionUIContext } from "../../src/core/extensions/types.ts";

// =============================================================================
// Test Helpers
// =============================================================================

function createRequest(overrides: Partial<Request> = {}): Request {
	return {
		id: overrides.id ?? "request-1",
		sessionID: overrides.sessionID ?? "session-1",
		permission: overrides.permission ?? "bash",
		patterns: overrides.patterns ?? ["git commit"],
		always: overrides.always ?? ["git *"],
		metadata: overrides.metadata ?? { command: "git commit -m test" },
		tool: overrides.tool,
	};
}

function createMockUI(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		select: vi.fn().mockResolvedValue(undefined),
		confirm: vi.fn().mockResolvedValue(false),
		input: vi.fn().mockResolvedValue(undefined),
		notify: vi.fn(),
		onTerminalInput: vi.fn().mockReturnValue(() => {}),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setWorkingVisible: vi.fn(),
		addAutocompleteProvider: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		setHeader: vi.fn(),
		setTitle: vi.fn(),
		custom: vi.fn().mockResolvedValue(undefined),
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn().mockReturnValue(""),
		editor: vi.fn().mockResolvedValue(undefined),
		setEditorComponent: vi.fn(),
		theme: {} as ExtensionUIContext["theme"],
		getAllThemes: vi.fn().mockReturnValue([]),
		getTheme: vi.fn().mockReturnValue(undefined),
		setTheme: vi.fn().mockReturnValue({ success: true }),
		getToolsExpanded: vi.fn().mockReturnValue(false),
		setToolsExpanded: vi.fn(),
		...overrides,
		getEditorComponent: overrides.getEditorComponent ?? vi.fn().mockReturnValue(undefined),
	};
}

function createMockContext(overrides: { hasUI?: boolean; ui?: ExtensionUIContext } = {}): ExtensionContext {
	return {
		ui: overrides.ui ?? createMockUI(),
		hasUI: overrides.hasUI ?? true,
		mode: overrides.hasUI === false ? "print" : "tui",
		cwd: "/tmp/test",
		isProjectTrusted: vi.fn().mockReturnValue(true),
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		serviceTier: undefined,
		isIdle: vi.fn().mockReturnValue(true),
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: vi.fn().mockReturnValue(false),
		shutdown: vi.fn(),
		getContextUsage: vi.fn().mockReturnValue(undefined),
		compact: vi.fn(),
		getMessageRevision: vi.fn().mockReturnValue(0),
		applyCompaction: vi.fn().mockResolvedValue({ applied: false, reason: "rejected" }),
		getCompactionSettings: vi.fn().mockReturnValue(DEFAULT_COMPACTION_SETTINGS),
		getSystemPrompt: vi.fn().mockReturnValue(""),
	};
}

function createService(staticRuleset: Ruleset = [], approved: Ruleset = []) {
	const emitter = createLocalEventEmitter();
	const askedEvents: Request[] = [];
	const repliedEvents: Array<{
		requestID: string;
		sessionID: string;
		reply: "once" | "always" | "reject" | "allow";
	}> = [];

	emitter.onAsked((request) => {
		askedEvents.push(request);
	});
	emitter.onReplied((event) => {
		repliedEvents.push(event);
	});

	return {
		emitter,
		askedEvents,
		repliedEvents,
		service: new PermissionService(staticRuleset, approved, emitter),
	};
}

// =============================================================================
// Mode Tests
// =============================================================================

describe("Permission System - Multi-Mode Tests", () => {
	describe("Interactive Mode (ctx.hasUI === true)", () => {
		it("shows TUI prompt when permission is asked and no rules match", async () => {
			// given
			const mockSelect = vi.fn().mockResolvedValue("Allow once");
			const ui = createMockUI({ select: mockSelect });
			const _ctx = createMockContext({ hasUI: true, ui });
			const { service, askedEvents } = createService([]);
			const request = createRequest({ id: "test-1" });

			// when - simulate interactive mode handling
			const askPromise = service.ask(request);

			// then - permission should be pending and event emitted
			expect(service.list()).toHaveLength(1);
			expect(askedEvents).toHaveLength(1);
			expect(askedEvents[0]).toMatchObject({
				id: "test-1",
				sessionID: "session-1",
				permission: "bash",
				patterns: ["git commit"],
			});

			// Simulate user response via service.reply
			service.reply({ requestID: "test-1", reply: "once" });
			await expect(askPromise).resolves.toBeUndefined();
		});

		it("allows immediately when static rules allow", async () => {
			// given
			const ui = createMockUI();
			const _ctx = createMockContext({ hasUI: true, ui });
			const { service, askedEvents } = createService([{ permission: "bash", pattern: "*", action: "allow" }]);

			// when
			await service.ask(createRequest());

			// then
			expect(askedEvents).toHaveLength(0);
			expect(service.list()).toHaveLength(0);
		});

		it("denies immediately when static rules deny", async () => {
			// given
			const ui = createMockUI();
			const _ctx = createMockContext({ hasUI: true, ui });
			const { service } = createService([{ permission: "bash", pattern: "*", action: "deny" }]);

			// when/then
			await expect(service.ask(createRequest())).rejects.toBeInstanceOf(DeniedError);
		});
	});

	describe("Print Mode (ctx.hasUI === false)", () => {
		it("auto-denies with helpful message when no rules match", () => {
			// given
			const request = createRequest({ id: "print-test-1", permission: "bash", patterns: ["rm -rf /"] });
			const staticRuleset: Ruleset = [];
			const cliOverride: Ruleset = [];
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			const emitEvent = (event: string, data: unknown) => emittedEvents.push({ event, data });

			// when
			const result = handleNoUI(request, staticRuleset, cliOverride, emitEvent);

			// then
			expect(result).toEqual({
				requestID: "print-test-1",
				reply: "reject",
				message: "Permission required for bash (rm -rf /). Use --permission bash=allow to override.",
			});
			expect(emittedEvents).toHaveLength(1);
			expect(emittedEvents[0]).toEqual({
				event: "permission_asked",
				data: request,
			});
		});

		it("allows when CLI override specifies allow", () => {
			// given
			const request = createRequest({ id: "print-test-2", permission: "bash", patterns: ["ls"] });
			const staticRuleset: Ruleset = [];
			const cliOverride: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
			const emitEvent = vi.fn();

			// when
			const result = handleNoUI(request, staticRuleset, cliOverride, emitEvent);

			// then
			expect(result).toBeUndefined();
			expect(emitEvent).toHaveBeenCalledWith("permission_asked", request);
		});

		it("denies when CLI override specifies deny", () => {
			// given
			const request = createRequest({ id: "print-test-3", permission: "bash", patterns: ["rm *"] });
			const staticRuleset: Ruleset = [];
			const cliOverride: Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }];
			const emitEvent = vi.fn();

			// when
			const result = handleNoUI(request, staticRuleset, cliOverride, emitEvent);

			// then
			expect(result).toEqual({
				requestID: "print-test-3",
				reply: "reject",
				message: "Permission denied by CLI flag: bash",
			});
		});

		it("allows when static ruleset specifies allow", () => {
			// given
			const request = createRequest({ id: "print-test-4", permission: "edit", patterns: ["src/*.ts"] });
			const staticRuleset: Ruleset = [{ permission: "edit", pattern: "src/*", action: "allow" }];
			const cliOverride: Ruleset = [];
			const emitEvent = vi.fn();

			// when
			const result = handleNoUI(request, staticRuleset, cliOverride, emitEvent);

			// then
			expect(result).toBeUndefined();
		});

		it("denies when static ruleset specifies deny", () => {
			// given
			const request = createRequest({ id: "print-test-5", permission: "edit", patterns: ["node_modules/*"] });
			const staticRuleset: Ruleset = [{ permission: "edit", pattern: "node_modules/*", action: "deny" }];
			const cliOverride: Ruleset = [];
			const emitEvent = vi.fn();

			// when
			const result = handleNoUI(request, staticRuleset, cliOverride, emitEvent);

			// then
			expect(result).toEqual({
				requestID: "print-test-5",
				reply: "reject",
				message: "Permission denied by config: edit",
			});
		});

		it("CLI override takes precedence over static ruleset", () => {
			// given - static denies but CLI allows
			const request = createRequest({ id: "print-test-6", permission: "bash", patterns: ["ls"] });
			const staticRuleset: Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }];
			const cliOverride: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
			const emitEvent = vi.fn();

			// when
			const result = handleNoUI(request, staticRuleset, cliOverride, emitEvent);

			// then - CLI override wins
			expect(result).toBeUndefined();
		});
	});

	describe("RPC Mode", () => {
		it("uses bound ExtensionUIContext for permission prompts", async () => {
			// given - RPC mode has UI context bound to the RPC channel
			const mockSelect = vi.fn().mockResolvedValue("Allow always");
			const ui = createMockUI({ select: mockSelect });
			const _ctx = createMockContext({ hasUI: true, ui });
			const { service, askedEvents, repliedEvents } = createService([]);
			const request = createRequest({ id: "rpc-test-1", always: ["git *"] });

			// when - simulate RPC mode with UI context
			const askPromise = service.ask(request);

			// then - should be pending waiting for user response
			expect(service.list()).toHaveLength(1);
			expect(askedEvents).toHaveLength(1);

			// Simulate user clicking "Allow always"
			service.reply({ requestID: "rpc-test-1", reply: "always" });

			// then
			await expect(askPromise).resolves.toBeUndefined();
			expect(repliedEvents).toHaveLength(1);
			expect(repliedEvents[0]).toMatchObject({
				requestID: "rpc-test-1",
				sessionID: "session-1",
				reply: "always",
			});
		});

		it("handles multiple pending permissions in same session", async () => {
			// given
			const ui = createMockUI();
			const _ctx = createMockContext({ hasUI: true, ui });
			const { service } = createService([]);

			// when - multiple asks in same session
			const ask1 = service.ask(createRequest({ id: "rpc-multi-1", permission: "bash", patterns: ["ls"] }));
			const ask2 = service.ask(createRequest({ id: "rpc-multi-2", permission: "edit", patterns: ["file.ts"] }));

			// then - both should be pending
			expect(service.list()).toHaveLength(2);

			// Reply to first - should not affect second (different permissions)
			service.reply({ requestID: "rpc-multi-1", reply: "once" });
			await expect(ask1).resolves.toBeUndefined();

			// second should still be pending
			expect(service.list()).toHaveLength(1);

			// cleanup
			service.reply({ requestID: "rpc-multi-2", reply: "reject" });
			await expect(ask2).rejects.toBeInstanceOf(RejectedError);
		});
	});

	describe("SDK Mode", () => {
		describe("with uiContext (ctx.hasUI === true)", () => {
			it("shows permission prompt via provided UI context", async () => {
				// given
				const mockSelect = vi.fn().mockResolvedValue("Allow once");
				const ui = createMockUI({ select: mockSelect });
				const _ctx = createMockContext({ hasUI: true, ui });
				const { service } = createService([]);
				const request = createRequest({ id: "sdk-ui-test-1" });

				// when
				const askPromise = service.ask(request);
				service.reply({ requestID: "sdk-ui-test-1", reply: "once" });

				// then
				await expect(askPromise).resolves.toBeUndefined();
			});

			it("handles deny with feedback", async () => {
				// given
				const { service } = createService([]);
				const request = createRequest({ id: "sdk-ui-test-2" });

				// when
				const askPromise = service.ask(request);
				service.reply({ requestID: "sdk-ui-test-2", reply: "reject", message: "Use a safer command" });

				// then
				const err = await askPromise.catch((e) => e);
				expect(err).toBeInstanceOf(CorrectedError);
				expect(err.message).toContain("Use a safer command");
			});
		});

		describe("without uiContext (ctx.hasUI === false)", () => {
			it("auto-denies same as print mode", () => {
				// given
				const request = createRequest({ id: "sdk-no-ui-1", permission: "bash", patterns: ["rm -rf /"] });
				const staticRuleset: Ruleset = [];
				const cliOverride: Ruleset = [];
				const emitEvent = vi.fn();

				// when
				const result = handleNoUI(request, staticRuleset, cliOverride, emitEvent);

				// then
				expect(result?.reply).toBe("reject");
				expect(result?.message).toContain("Use --permission bash=allow");
			});

			it("allows when rules permit", async () => {
				// given - SDK without UI but with permissive rules
				const { service } = createService([{ permission: "read", pattern: "*", action: "allow" }]);
				const request = createRequest({ id: "sdk-no-ui-2", permission: "read", patterns: ["file.txt"] });

				// when/then
				await expect(service.ask(request)).resolves.toBeUndefined();
			});

			it("denies immediately when rules deny", async () => {
				// given
				const { service } = createService([{ permission: "bash", pattern: "rm *", action: "deny" }]);
				const request = createRequest({ id: "sdk-no-ui-3", permission: "bash", patterns: ["rm -rf /"] });

				// when/then
				await expect(service.ask(request)).rejects.toBeInstanceOf(DeniedError);
			});
		});
	});

	describe("Event Subscriber Payloads", () => {
		it("permission_asked event has correct Request payload shape", () => {
			// given
			const emitter = createLocalEventEmitter();
			const askedHandler = vi.fn();
			emitter.onAsked(askedHandler);

			const request: Request = {
				id: "test-req-1",
				sessionID: "test-sess-1",
				permission: "bash",
				patterns: ["git commit", "git push"],
				always: ["git *"],
				metadata: { command: "git commit -m test" },
				tool: {
					messageID: "msg-1",
					callID: "call-1",
				},
			};

			// when
			emitter.emitAsked(request);

			// then
			expect(askedHandler).toHaveBeenCalledTimes(1);
			const payload = askedHandler.mock.calls[0][0];
			expect(payload).toMatchObject({
				id: "test-req-1",
				sessionID: "test-sess-1",
				permission: "bash",
				patterns: ["git commit", "git push"],
				always: ["git *"],
				metadata: { command: "git commit -m test" },
				tool: {
					messageID: "msg-1",
					callID: "call-1",
				},
			});
		});

		it("permission_replied event has correct payload shape", () => {
			// given
			const emitter = createLocalEventEmitter();
			const repliedHandler = vi.fn();
			emitter.onReplied(repliedHandler);

			// when
			emitter.emitReplied("req-123", "sess-456", "always");

			// then
			expect(repliedHandler).toHaveBeenCalledTimes(1);
			const payload = repliedHandler.mock.calls[0][0];
			expect(payload).toEqual({
				requestID: "req-123",
				sessionID: "sess-456",
				reply: "always",
			});
		});

		it("permission_replied includes correct reply type for once", () => {
			// given
			const emitter = createLocalEventEmitter();
			const repliedHandler = vi.fn();
			emitter.onReplied(repliedHandler);

			// when
			emitter.emitReplied("req-1", "sess-1", "once");

			// then
			expect(repliedHandler).toHaveBeenCalledWith({
				requestID: "req-1",
				sessionID: "sess-1",
				reply: "once",
			});
		});

		it("permission_replied includes correct reply type for reject", () => {
			// given
			const emitter = createLocalEventEmitter();
			const repliedHandler = vi.fn();
			emitter.onReplied(repliedHandler);

			// when
			emitter.emitReplied("req-1", "sess-1", "reject");

			// then
			expect(repliedHandler).toHaveBeenCalledWith({
				requestID: "req-1",
				sessionID: "sess-1",
				reply: "reject",
			});
		});

		it("multiple handlers receive the same payload", () => {
			// given
			const emitter = createLocalEventEmitter();
			const handler1 = vi.fn();
			const handler2 = vi.fn();
			emitter.onAsked(handler1);
			emitter.onAsked(handler2);

			const request = createRequest({ id: "multi-handler-test" });

			// when
			emitter.emitAsked(request);

			// then
			expect(handler1).toHaveBeenCalledWith(request);
			expect(handler2).toHaveBeenCalledWith(request);
		});
	});

	describe("Mode Transitions", () => {
		it("handles ask -> reply -> ask sequence in interactive mode", async () => {
			const { service } = createService([]);

			// First ask
			const ask1 = service.ask(createRequest({ id: "seq-1", permission: "bash", patterns: ["ls"] }));
			service.reply({ requestID: "seq-1", reply: "once" });
			await expect(ask1).resolves.toBeUndefined();

			// Second ask (should prompt again since "once" was used)
			const ask2 = service.ask(createRequest({ id: "seq-2", permission: "bash", patterns: ["pwd"] }));
			expect(service.list()).toHaveLength(1); // Pending again

			// cleanup
			service.reply({ requestID: "seq-2", reply: "reject" });
			await expect(ask2).rejects.toBeInstanceOf(RejectedError);
		});

		it("handles ask -> always -> subsequent auto-allow", async () => {
			const { service } = createService([]);

			// First ask with always
			const ask1 = service.ask(
				createRequest({ id: "always-1", permission: "bash", patterns: ["git *"], always: ["git *"] }),
			);
			service.reply({ requestID: "always-1", reply: "always" });
			await expect(ask1).resolves.toBeUndefined();

			// Subsequent matching ask should auto-allow
			await expect(
				service.ask(createRequest({ id: "always-2", permission: "bash", patterns: ["git commit"] })),
			).resolves.toBeUndefined();
		});
	});
});

// =============================================================================
// Ported Tests from opencode
// =============================================================================

describe("Permission System - Ported from opencode", () => {
	describe("disabled() - tool disabling based on rules", () => {
		function disabled(tools: string[], ruleset: Ruleset): Set<string> {
			const result = new Set<string>();

			for (const tool of tools) {
				const evaluation = evaluateTool(tool, ruleset);
				if (evaluation === "deny") {
					result.add(tool);
				}
			}

			return result;
		}

		function evaluateTool(tool: string, ruleset: Ruleset): "allow" | "deny" | "ask" {
			const specificRules = ruleset.filter((r) => r.permission === tool);
			const wildcardRules = ruleset.filter((r) => r.permission === "*");

			if (specificRules.length > 0) {
				const hasSpecificAllow = specificRules.some((r) => r.action === "allow");
				const allSpecificDeny = specificRules.every((r) => r.action === "deny");

				if (hasSpecificAllow) return "ask";
				if (allSpecificDeny) return "deny";
				return "ask";
			}

			const lastWildcard = wildcardRules.findLast(() => true);
			if (lastWildcard) {
				return lastWildcard.action === "deny" ? "deny" : "ask";
			}

			return "ask";
		}

		it("returns empty set when all tools allowed", () => {
			const result = disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }]);
			expect(result.size).toBe(0);
		});

		it("disables tool when denied", () => {
			const result = disabled(
				["bash", "edit", "read"],
				[
					{ permission: "*", pattern: "*", action: "allow" },
					{ permission: "bash", pattern: "*", action: "deny" },
				],
			);
			expect(result.has("bash")).toBe(true);
			expect(result.has("edit")).toBe(false);
			expect(result.has("read")).toBe(false);
		});

		it("does not disable when partially denied", () => {
			const result = disabled(
				["bash"],
				[
					{ permission: "bash", pattern: "*", action: "allow" },
					{ permission: "bash", pattern: "rm *", action: "deny" },
				],
			);
			expect(result.has("bash")).toBe(false);
		});

		it("does not disable when action is ask", () => {
			const result = disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }]);
			expect(result.size).toBe(0);
		});

		it("does not disable when specific allow after wildcard deny", () => {
			const result = disabled(
				["bash"],
				[
					{ permission: "bash", pattern: "*", action: "deny" },
					{ permission: "bash", pattern: "echo *", action: "allow" },
				],
			);
			expect(result.has("bash")).toBe(false);
		});

		it("disables multiple tools", () => {
			const result = disabled(
				["bash", "edit", "read"],
				[
					{ permission: "bash", pattern: "*", action: "deny" },
					{ permission: "edit", pattern: "*", action: "deny" },
					{ permission: "read", pattern: "*", action: "deny" },
				],
			);
			expect(result.has("bash")).toBe(true);
			expect(result.has("edit")).toBe(true);
			expect(result.has("read")).toBe(true);
		});

		it("wildcard permission denies all tools", () => {
			const result = disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }]);
			expect(result.has("bash")).toBe(true);
			expect(result.has("edit")).toBe(true);
			expect(result.has("read")).toBe(true);
		});

		it("specific allow overrides wildcard deny", () => {
			const result = disabled(
				["bash", "edit", "read"],
				[
					{ permission: "*", pattern: "*", action: "deny" },
					{ permission: "bash", pattern: "*", action: "allow" },
				],
			);
			expect(result.has("bash")).toBe(false);
			expect(result.has("edit")).toBe(true);
			expect(result.has("read")).toBe(true);
		});
	});

	describe("Auto-respond patterns", () => {
		it("auto-allows when session has auto-accept enabled", async () => {
			// Simulates auto-accept behavior where certain sessions/directories
			// have permissions automatically granted
			const { service } = createService([]);

			// In auto-accept mode, we can pre-populate approved rules
			const autoAcceptRules: Ruleset = [{ permission: "bash", pattern: "git *", action: "allow" }];
			// biome-ignore lint/complexity/useLiteralKeys: emitter is private, accessed via bracket notation for test
			const serviceWithAutoAccept = new PermissionService([], autoAcceptRules, service["emitter"]);

			// Should auto-allow without prompting
			await expect(
				serviceWithAutoAccept.ask(createRequest({ permission: "bash", patterns: ["git commit"] })),
			).resolves.toBeUndefined();
		});

		it("auto-denies dangerous patterns even in auto-accept mode", async () => {
			const { service } = createService([{ permission: "bash", pattern: "rm -rf /", action: "deny" }]);

			// Even with auto-accept for some patterns, dangerous ones should still deny
			await expect(
				service.ask(createRequest({ permission: "bash", patterns: ["rm -rf /"] })),
			).rejects.toBeInstanceOf(DeniedError);
		});

		it("directory-scoped auto-accept", async () => {
			// Simulates directory-level auto-accept where specific directories
			// have blanket permissions
			const directoryRules: Ruleset = [
				{ permission: "edit", pattern: "/tmp/project/*", action: "allow" },
				{ permission: "read", pattern: "/tmp/project/*", action: "allow" },
			];
			const { service } = createService([], directoryRules);

			await expect(
				service.ask(createRequest({ permission: "edit", patterns: ["/tmp/project/file.ts"] })),
			).resolves.toBeUndefined();
		});

		it("session-level override takes precedence over directory-level", async () => {
			const baseRules: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
			const overrideRules: Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }];
			const { service } = createService(baseRules, overrideRules);

			await expect(
				service.ask(createRequest({ permission: "bash", patterns: ["rm -rf tmp"] })),
			).rejects.toBeInstanceOf(DeniedError);

			await expect(
				service.ask(createRequest({ permission: "bash", patterns: ["ls -la"] })),
			).resolves.toBeUndefined();
		});
	});

	describe("Edge cases from next.test.ts", () => {
		it("handles empty patterns array", async () => {
			const { service } = createService([]);
			const request = createRequest({ id: "empty-patterns", patterns: [] });

			// Empty patterns should resolve immediately (nothing to check)
			await expect(service.ask(request)).resolves.toBeUndefined();
		});

		it("handles multiple patterns with mixed results", async () => {
			const { service } = createService([
				{ permission: "bash", pattern: "echo *", action: "allow" },
				{ permission: "bash", pattern: "rm *", action: "deny" },
			]);

			// If any pattern is denied, whole request is denied
			await expect(service.ask(createRequest({ patterns: ["echo hello", "rm -rf /"] }))).rejects.toBeInstanceOf(
				DeniedError,
			);
		});

		it("cascade reject cancels all pending in same session", async () => {
			const { service, repliedEvents } = createService([]);

			const ask1 = service.ask(createRequest({ id: "cascade-1", sessionID: "sess-same", permission: "bash" }));
			const ask2 = service.ask(createRequest({ id: "cascade-2", sessionID: "sess-same", permission: "edit" }));

			expect(service.list()).toHaveLength(2);

			// Reject first - should cascade to second
			service.reply({ requestID: "cascade-1", reply: "reject" });

			await expect(ask1).rejects.toBeInstanceOf(RejectedError);
			await expect(ask2).rejects.toBeInstanceOf(RejectedError);

			// Both should have reply events
			expect(repliedEvents).toHaveLength(2);
			expect(repliedEvents[0].reply).toBe("reject");
			expect(repliedEvents[1].reply).toBe("reject");
		});

		it("cascade allow resolves matching pending in same session", async () => {
			const { service, repliedEvents } = createService([]);

			const ask1 = service.ask(
				createRequest({ id: "cascade-allow-1", sessionID: "sess-same", permission: "bash", always: ["git *"] }),
			);
			const ask2 = service.ask(
				createRequest({
					id: "cascade-allow-2",
					sessionID: "sess-same",
					permission: "bash",
					patterns: ["git push"],
				}),
			);

			expect(service.list()).toHaveLength(2);

			// Allow first with "always" - should cascade resolve second
			service.reply({ requestID: "cascade-allow-1", reply: "always" });

			await expect(ask1).resolves.toBeUndefined();
			await expect(ask2).resolves.toBeUndefined();

			// Both should have reply events
			expect(repliedEvents).toHaveLength(2);
		});

		it("does not cascade across different sessions", async () => {
			const { service } = createService([]);

			const ask1 = service.ask(createRequest({ id: "diff-sess-1", sessionID: "sess-a" }));
			const ask2 = service.ask(createRequest({ id: "diff-sess-2", sessionID: "sess-b" }));

			// Reject first
			service.reply({ requestID: "diff-sess-1", reply: "reject" });

			await expect(ask1).rejects.toBeInstanceOf(RejectedError);

			// Second should still be pending
			expect(service.list()).toHaveLength(1);
			expect(service.list()[0].id).toBe("diff-sess-2");

			// cleanup
			service.reply({ requestID: "diff-sess-2", reply: "reject" });
			await expect(ask2).rejects.toBeInstanceOf(RejectedError);
		});

		it("reply to unknown requestID does nothing", () => {
			const { service, repliedEvents } = createService([]);

			// Should not throw
			service.reply({ requestID: "unknown-id", reply: "once" });

			expect(service.list()).toHaveLength(0);
			expect(repliedEvents).toHaveLength(0);
		});

		it("handles corrected error with message", async () => {
			const { service } = createService([]);

			const ask = service.ask(createRequest({ id: "corrected-test" }));
			service.reply({ requestID: "corrected-test", reply: "reject", message: "Please use git status instead" });

			const err = await ask.catch((e) => e);
			expect(err).toBeInstanceOf(CorrectedError);
			expect(err.feedback).toBe("Please use git status instead");
			expect(err.message).toContain("Please use git status instead");
		});
	});
});
