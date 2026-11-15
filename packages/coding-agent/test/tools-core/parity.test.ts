import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";
import { createToolMachine } from "../../src/core/tools/machine.ts";
import {
	createCoreBashToolDefinition,
	createCoreEditToolDefinition,
	createCoreReadToolDefinition,
	createCoreWriteToolDefinition,
} from "../../src/tools-core.ts";

// Prompt-byte contract: a host running the worker-safe cores offers the model exactly the tools a local session does.
const cwd = "/workspace";
const machine = createToolMachine();
const local = createAllToolDefinitions(cwd);
const core: Record<"bash" | "read" | "edit" | "write", ToolDefinition<any, any>> = {
	bash: createCoreBashToolDefinition(cwd, { machine }),
	read: createCoreReadToolDefinition(cwd, { machine }),
	edit: createCoreEditToolDefinition(cwd, { machine }),
	write: createCoreWriteToolDefinition(cwd, { machine }),
};

const modelFacing = (definition: ToolDefinition<any, any>) =>
	JSON.stringify({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});

describe("tools-core definitions", () => {
	it.each(["bash", "read", "edit", "write"] as const)("%s matches the local tool byte for byte", (name) => {
		expect(modelFacing(core[name])).toBe(modelFacing(local[name]));
	});
});
