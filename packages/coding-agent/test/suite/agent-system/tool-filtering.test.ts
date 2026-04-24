import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENTS } from "../../../src/core/extensions/builtin/agent-system/builtin-agents.js";
import agentSystemExtension from "../../../src/core/extensions/builtin/agent-system/index.js";
import { AgentRegistry } from "../../../src/core/extensions/builtin/agent-system/registry.js";
import { AGENT_TYPE_ENV_VAR } from "../../../src/core/extensions/builtin/background-task/types.js";
import type { ToolInfo } from "../../../src/core/extensions/types.js";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.js";
import { createTestExtensionsResult } from "../../utilities.js";

vi.mock("../../../src/core/extensions/builtin/agent-system/registry.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/core/extensions/builtin/agent-system/registry.js")>();
	return {
		...actual,
		createRegistry: vi.fn(),
	};
});

import { createRegistry } from "../../../src/core/extensions/builtin/agent-system/registry.js";

const mockCreateRegistry = vi.mocked(createRegistry);

function createToolInfo(name: string): ToolInfo {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		sourceInfo: createSyntheticSourceInfo(`<test:${name}>`, { source: "test" }),
	};
}

async function runSessionStart(options: { agentType: "explore" | "general"; tools: ToolInfo[] }): Promise<string[]> {
	vi.stubEnv(AGENT_TYPE_ENV_VAR, options.agentType);
	mockCreateRegistry.mockResolvedValue(
		new AgentRegistry(new Map([[options.agentType, BUILTIN_AGENTS[options.agentType]]])),
	);

	const extensionsResult = await createTestExtensionsResult([agentSystemExtension], "/tmp");
	const extension = extensionsResult.extensions[0];
	const sessionStartHandler = extension.handlers.get("session_start")?.[0];
	if (!sessionStartHandler) {
		throw new Error("Expected session_start handler");
	}

	const setActiveTools = vi.fn();
	extensionsResult.runtime.getAllTools = vi.fn().mockReturnValue(options.tools);
	extensionsResult.runtime.setActiveTools = setActiveTools;

	await sessionStartHandler({ type: "session_start", reason: "startup" }, { cwd: "/tmp" });

	const [activeTools] = setActiveTools.mock.calls[0] ?? [];
	if (!activeTools) {
		throw new Error("Expected setActiveTools to be called");
	}

	return activeTools as string[];
}

describe("agent-system tool filtering", () => {
	afterEach(() => {
		mockCreateRegistry.mockReset();
		vi.unstubAllEnvs();
	});

	it("activates only read-only tools for explore agent", async () => {
		// given
		const tools = ["read", "grep", "find", "ls", "bash", "write", "edit", "task", "todowrite"].map(createToolInfo);

		// when
		const activeTools = await runSessionStart({ agentType: "explore", tools });

		// then
		expect(activeTools).toEqual(["read", "grep", "find", "ls", "bash"]);
	});

	it("excludes task and todowrite for general agent", async () => {
		// given
		const tools = ["read", "grep", "find", "ls", "bash", "write", "edit", "task", "todowrite"].map(createToolInfo);

		// when
		const activeTools = await runSessionStart({ agentType: "general", tools });

		// then
		expect(activeTools).toEqual(["read", "grep", "find", "ls", "bash", "write", "edit"]);
	});
});
