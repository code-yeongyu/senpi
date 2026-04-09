import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENTS } from "../../../src/core/extensions/builtin/agent-system/builtin-agents.js";
import agentSystemExtension from "../../../src/core/extensions/builtin/agent-system/index.js";
import { AGENT_TYPE_ENV_VAR } from "../../../src/core/extensions/builtin/background-task/types.js";

vi.mock("../../../src/core/extensions/builtin/agent-system/registry.js", () => ({
	createRegistry: vi.fn(),
}));

import { createRegistry } from "../../../src/core/extensions/builtin/agent-system/registry.js";

type EventHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

type MockPi = {
	on: ReturnType<typeof vi.fn>;
	getAllTools: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	_handlers: Record<string, EventHandler[]>;
	_trigger: (event: string, eventData: unknown, ctx: unknown) => Promise<unknown>;
};

const mockCreateRegistry = vi.mocked(createRegistry);

function bindExtension(mockPi: MockPi): void {
	agentSystemExtension(mockPi as never);
}

function createMockPi(): MockPi {
	const handlers: Record<string, EventHandler[]> = {};

	return {
		on: vi.fn((event: string, handler: EventHandler) => {
			handlers[event] = handlers[event] ?? [];
			handlers[event].push(handler);
		}),
		getAllTools: vi
			.fn()
			.mockReturnValue([
				{ name: "read" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "bash" },
				{ name: "grep" },
				{ name: "find" },
				{ name: "ls" },
				{ name: "task" },
				{ name: "todowrite" },
			]),
		setActiveTools: vi.fn(),
		_handlers: handlers,
		async _trigger(event: string, eventData: unknown, ctx: unknown): Promise<unknown> {
			for (const handler of handlers[event] ?? []) {
				const result = await handler(eventData, ctx);
				if (result !== undefined) {
					return result;
				}
			}

			return undefined;
		},
	};
}

function createMockRegistry(agent = BUILTIN_AGENTS.explore) {
	return {
		get: vi.fn().mockReturnValue(agent),
		getAvailableAgentDescriptions: vi.fn().mockReturnValue("Available agent types:\n- explore: explore agent"),
	};
}

describe("agent-system extension integration", () => {
	const originalAgentType = process.env[AGENT_TYPE_ENV_VAR];

	beforeEach(() => {
		mockCreateRegistry.mockReset();
		delete process.env[AGENT_TYPE_ENV_VAR];
	});

	afterEach(() => {
		mockCreateRegistry.mockReset();
		vi.restoreAllMocks();
		if (originalAgentType === undefined) {
			delete process.env[AGENT_TYPE_ENV_VAR];
		} else {
			process.env[AGENT_TYPE_ENV_VAR] = originalAgentType;
		}
	});

	it("extension is no-op when SANEPI_AGENT_TYPE not set", () => {
		// given
		delete process.env[AGENT_TYPE_ENV_VAR];
		const mockPi = createMockPi();

		// when
		bindExtension(mockPi);

		// then
		expect(mockPi.on).not.toHaveBeenCalled();
		expect(mockCreateRegistry).not.toHaveBeenCalled();
	});

	it("activates only read-only tools for the explore agent", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = BUILTIN_AGENTS.explore.name;
		const mockPi = createMockPi();
		mockCreateRegistry.mockResolvedValue(createMockRegistry(BUILTIN_AGENTS.explore) as never);

		// when
		bindExtension(mockPi);
		await mockPi._trigger("session_start", { type: "session_start", reason: "new" }, { cwd: "/tmp", hasUI: false });

		// then
		expect(mockPi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "grep", "find", "ls"]);
	});

	it("excludes task and todowrite for the general agent", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = BUILTIN_AGENTS.general.name;
		const mockPi = createMockPi();
		mockCreateRegistry.mockResolvedValue(createMockRegistry(BUILTIN_AGENTS.general) as never);

		// when
		bindExtension(mockPi);
		await mockPi._trigger("session_start", { type: "session_start", reason: "new" }, { cwd: "/tmp", hasUI: false });

		// then
		expect(mockPi.setActiveTools).toHaveBeenCalledWith(["read", "edit", "write", "bash", "grep", "find", "ls"]);
	});

	it("logs a warning and keeps restrictions unset for an unknown agent type", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = "unknown-agent";
		const mockPi = createMockPi();
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		mockCreateRegistry.mockResolvedValue({
			get: vi.fn().mockReturnValue(undefined),
			getAvailableAgentDescriptions: vi.fn().mockReturnValue("Available agent types:\n- explore: explore agent"),
		} as never);

		// when
		bindExtension(mockPi);
		await mockPi._trigger("session_start", { type: "session_start", reason: "new" }, { cwd: "/tmp", hasUI: false });

		// then
		expect(stderrWrite).toHaveBeenCalledWith(
			'[agent-system] Unknown agent type: "unknown-agent". Available: Available agent types:\n- explore: explore agent\n',
		);
		expect(mockPi.setActiveTools).not.toHaveBeenCalled();
		expect(mockPi._handlers.tool_call).toBeUndefined();
	});

	it("defers denied tool-call blocking to the permission-system extension", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = BUILTIN_AGENTS.explore.name;
		const mockPi = createMockPi();
		mockCreateRegistry.mockResolvedValue(createMockRegistry(BUILTIN_AGENTS.explore) as never);
		bindExtension(mockPi);
		await mockPi._trigger("session_start", { type: "session_start", reason: "new" }, { cwd: "/tmp", hasUI: false });

		// when
		const result = await mockPi._trigger(
			"tool_call",
			{ type: "tool_call", toolCallId: "call-1", toolName: "edit", input: { filePath: "/tmp/file.ts" } },
			{ hasUI: false, ui: { select: vi.fn() } },
		);

		// then
		expect(result).toBeUndefined();
	});

	it("allows permitted tool calls for the explore agent", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = BUILTIN_AGENTS.explore.name;
		const mockPi = createMockPi();
		mockCreateRegistry.mockResolvedValue(createMockRegistry(BUILTIN_AGENTS.explore) as never);
		bindExtension(mockPi);
		await mockPi._trigger("session_start", { type: "session_start", reason: "new" }, { cwd: "/tmp", hasUI: false });

		// when
		const result = await mockPi._trigger(
			"tool_call",
			{ type: "tool_call", toolCallId: "call-1", toolName: "read", input: { filePath: "/tmp/file.ts" } },
			{ hasUI: false, ui: { select: vi.fn() } },
		);

		// then
		expect(result).toBeUndefined();
	});

	it("appends the explore prompt before the agent starts", async () => {
		// given
		process.env[AGENT_TYPE_ENV_VAR] = BUILTIN_AGENTS.explore.name;
		const mockPi = createMockPi();
		mockCreateRegistry.mockResolvedValue(createMockRegistry(BUILTIN_AGENTS.explore) as never);
		bindExtension(mockPi);
		await mockPi._trigger("session_start", { type: "session_start", reason: "new" }, { cwd: "/tmp", hasUI: false });

		// when
		const result = await mockPi._trigger(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "find files", systemPrompt: "Base system prompt" },
			{ cwd: "/tmp", hasUI: false },
		);

		// then
		expect(result).toEqual({
			systemPrompt: `Base system prompt\n\n${BUILTIN_AGENTS.explore.prompt}`,
		});
		expect(result).toEqual(
			expect.objectContaining({ systemPrompt: expect.stringContaining("file search specialist") }),
		);
	});
});
