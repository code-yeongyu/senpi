import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANEPI_CONVERSATION_EVENT, SANEPI_SYSTEM_PREFIX } from "../../src/core/extensions/builtin/system-messages.js";
import { buildContinuationPrompt } from "../../src/core/extensions/builtin/todotools/continuation/prompt.js";
import { installContinuation } from "../../src/core/extensions/builtin/todotools/continuation/runtime.js";
import type { TodoItem } from "../../src/core/extensions/builtin/todotools/state.js";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

type MockPi = {
	on: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	events: {
		emit: ReturnType<typeof vi.fn>;
	};
	_handlers: Record<string, EventHandler[]>;
	_trigger: (event: string, eventData: unknown, ctx?: ExtensionContext) => Promise<unknown>;
};

function createMockPi(cliFlag?: unknown): MockPi {
	const handlers: Record<string, EventHandler[]> = {};

	return {
		on: vi.fn((event: string, handler: EventHandler) => {
			handlers[event] = handlers[event] ?? [];
			handlers[event].push(handler);
		}),
		registerFlag: vi.fn(),
		getFlag: vi.fn(() => cliFlag),
		sendUserMessage: vi.fn(),
		events: {
			emit: vi.fn(),
		},
		_handlers: handlers,
		async _trigger(event: string, eventData: unknown, ctx?: ExtensionContext): Promise<unknown> {
			let result: unknown;
			for (const handler of handlers[event] ?? []) {
				result = await handler(eventData, ctx ?? createMockContext());
			}
			return result;
		},
	};
}

function createMockContext(options?: {
	cwd?: string;
	hasUI?: boolean;
	sessionId?: string;
	isIdle?: () => boolean;
}): ExtensionContext {
	return {
		cwd: options?.cwd ?? "/tmp/project",
		hasUI: options?.hasUI ?? true,
		isIdle: options?.isIdle ?? (() => true),
		sessionManager: {
			getSessionId: () => options?.sessionId ?? "session-1",
		},
		ui: {
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

function createAgentEndEvent(stopReason: "stop" | "toolUse" | "error" | "aborted" | "length" = "stop"): AgentEndEvent {
	return {
		type: "agent_end",
		messages: [fauxAssistantMessage("done", { stopReason })],
	};
}

function createAgentEndEventWithErrorMessage(stopReason: "stop" | "toolUse", errorMessage: string): AgentEndEvent {
	const assistant = fauxAssistantMessage("done", { stopReason, errorMessage });
	return {
		type: "agent_end",
		messages: [assistant],
	};
}

function createBeforeAgentStartEvent(prompt: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt,
		systemPrompt: "Base system prompt",
		systemPromptOptions: { cwd: "/tmp/test" },
	};
}

const pendingTodos: TodoItem[] = [
	{ content: "Implement the runtime handler", status: "in_progress", priority: "high" },
	{ content: "Verify the extension wiring", status: "pending", priority: "medium" },
];

describe("todotools continuation runtime", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers the flag and required lifecycle handlers without turn_end injection", () => {
		const mockPi = createMockPi();

		installContinuation(mockPi as never, {
			getCurrentTodos: () => [],
		});

		expect(mockPi.registerFlag).toHaveBeenCalledWith("disable-todo-continuation", {
			type: "boolean",
			default: false,
			description: "Disable todo continuation — automatic follow-up when incomplete todos remain in the list",
		});
		expect(Object.keys(mockPi._handlers).sort()).toEqual([
			"agent_end",
			"before_agent_start",
			"session_shutdown",
			"session_start",
		]);
		expect(mockPi._handlers.turn_end).toBeUndefined();
	});

	it("dispatches continuation asynchronously once the session becomes idle", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		const getCurrentTodos = vi.fn(() => pendingTodos);
		let idleChecks = 0;
		const ctx = createMockContext({
			isIdle: () => {
				idleChecks += 1;
				return idleChecks >= 2;
			},
		});

		installContinuation(mockPi as never, { getCurrentTodos });

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx);

		expect(getCurrentTodos).toHaveBeenCalledTimes(1);
		expect(mockPi.sendUserMessage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(0);
		expect(mockPi.sendUserMessage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(50);
		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(mockPi.sendUserMessage).toHaveBeenNthCalledWith(
			1,
			`${SANEPI_SYSTEM_PREFIX}\n${buildContinuationPrompt(pendingTodos)}`,
		);
		expect(mockPi.sendUserMessage.mock.calls[0]).toHaveLength(1);
		expect(typeof mockPi.sendUserMessage.mock.calls[0]?.[0]).toBe("string");
		expect(mockPi.events.emit).toHaveBeenCalledWith(
			SANEPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "injected",
				route: "todotools.continuation",
				sessionId: "session-1",
				conversation: expect.objectContaining({
					kind: "user_message",
					prefix: SANEPI_SYSTEM_PREFIX,
				}),
				text: `${SANEPI_SYSTEM_PREFIX}\n${buildContinuationPrompt(pendingTodos)}`,
			}),
		);
	});

	it("suppresses continuation for non-clean stop reasons before reading todos", async () => {
		const stopReasons = ["aborted", "error", "length"] as const;

		for (const stopReason of stopReasons) {
			const mockPi = createMockPi();
			const getCurrentTodos = vi.fn(() => pendingTodos);

			installContinuation(mockPi as never, { getCurrentTodos });
			await mockPi._trigger("agent_end", createAgentEndEvent(stopReason));

			expect(getCurrentTodos).not.toHaveBeenCalled();
			expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
		}
	});

	it("still dispatches continuation for recovered toolUse turns that retain an errorMessage", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		const getCurrentTodos = vi.fn(() => pendingTodos);

		installContinuation(mockPi as never, { getCurrentTodos });

		await mockPi._trigger(
			"agent_end",
			createAgentEndEventWithErrorMessage("toolUse", "JSON error injected into SSE stream"),
		);
		await vi.advanceTimersByTimeAsync(0);

		expect(getCurrentTodos).toHaveBeenCalledTimes(1);
		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("skips continuation in non-interactive contexts", async () => {
		const mockPi = createMockPi();

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), createMockContext({ hasUI: false }));

		expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("allows the next continuation cycle after a continuation-originated follow-up prompt", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"));
		await vi.advanceTimersByTimeAsync(0);
		await mockPi._trigger("before_agent_start", createBeforeAgentStartEvent(buildContinuationPrompt(pendingTodos)));
		await mockPi._trigger("agent_end", createAgentEndEvent("stop"));
		await vi.advanceTimersByTimeAsync(0);

		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);
	});

	it("aborts a pending deferred dispatch when a fresh prompt arrives", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		let isIdle = false;
		const ctx = createMockContext({
			sessionId: "session-fresh-prompt",
			isIdle: () => isIdle,
		});

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx);
		await vi.advanceTimersByTimeAsync(0);
		await mockPi._trigger("before_agent_start", createBeforeAgentStartEvent("new user request"), ctx);

		isIdle = true;
		await vi.advanceTimersByTimeAsync(100);

		expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("resets or clears per-session state on reload and shutdown events", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		const ctx = createMockContext({ sessionId: "session-2" });

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx);
		await vi.advanceTimersByTimeAsync(0);
		await mockPi._trigger(
			"session_start",
			{ type: "session_start", reason: "reload" } satisfies SessionStartEvent,
			ctx,
		);
		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx);
		await vi.advanceTimersByTimeAsync(0);
		await mockPi._trigger(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" } satisfies SessionShutdownEvent,
			ctx,
		);
		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx);
		await vi.advanceTimersByTimeAsync(0);

		expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(3);
	});

	it("aborts a pending deferred dispatch when the session reloads", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		let isIdle = false;
		const ctx = createMockContext({
			sessionId: "session-reload-abort",
			isIdle: () => isIdle,
		});

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx);
		await vi.advanceTimersByTimeAsync(0);
		await mockPi._trigger(
			"session_start",
			{ type: "session_start", reason: "reload" } satisfies SessionStartEvent,
			ctx,
		);

		isIdle = true;
		await vi.advanceTimersByTimeAsync(100);

		expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("aborts a pending deferred dispatch when the session shuts down", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		let isIdle = false;
		const ctx = createMockContext({
			sessionId: "session-shutdown-abort",
			isIdle: () => isIdle,
		});

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx);
		await vi.advanceTimersByTimeAsync(0);
		await mockPi._trigger(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" } satisfies SessionShutdownEvent,
			ctx,
		);

		isIdle = true;
		await vi.advanceTimersByTimeAsync(100);

		expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("logs a warning and gives up if the session never becomes idle", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await mockPi._trigger("agent_end", createAgentEndEvent("stop"), createMockContext({ isIdle: () => false }));
		await vi.advanceTimersByTimeAsync(10_050);

		expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			"[todotools continuation] Timed out waiting for idle state; skipping auto-dispatch.",
		);
	});

	it("catches deferred sendUserMessage errors and reports them without throwing", async () => {
		vi.useFakeTimers();
		const mockPi = createMockPi();
		const ctx = createMockContext({ sessionId: "session-3" });
		mockPi.sendUserMessage.mockImplementation(() => {
			throw new Error("follow-up failed");
		});

		installContinuation(mockPi as never, {
			getCurrentTodos: () => pendingTodos,
		});

		await expect(mockPi._trigger("agent_end", createAgentEndEvent("stop"), ctx)).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(0);
		expect(mockPi.events.emit).toHaveBeenCalledWith(
			"todotools:continuation_error",
			expect.objectContaining({
				sessionId: "session-3",
				message: "follow-up failed",
			}),
		);
		expect(mockPi.events.emit).toHaveBeenCalledWith(
			SANEPI_CONVERSATION_EVENT,
			expect.objectContaining({
				version: 1,
				source: "builtin",
				action: "failed",
				route: "todotools.continuation",
				sessionId: "session-3",
				conversation: expect.objectContaining({
					kind: "user_message",
					prefix: SANEPI_SYSTEM_PREFIX,
				}),
				errorMessage: "follow-up failed",
			}),
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Todo continuation failed: follow-up failed", "error");
	});
});
