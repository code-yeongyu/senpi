import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createBashTool } from "../../src/core/tools/bash.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { createAllToolDefinitions, createCodingTools } from "../../src/core/tools/index.ts";
import { createToolMachine } from "../../src/core/tools/machine.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";
import {
	createCoreBashTool,
	createCoreBashToolDefinition,
	createCoreEditTool,
	createCoreEditToolDefinition,
	createCoreReadTool,
	createCoreReadToolDefinition,
	createCoreWriteTool,
	createCoreWriteToolDefinition,
	type CoreCodingTools,
	createCoreCodingTools,
	createMachineOutputSpill,
	type ToolMachine,
} from "../../src/tools-core.ts";
import { createFakeMachine, type ScriptedExec } from "./support/fake-machine.ts";

// Prompt-byte and public API contract: a host running the worker-safe cores offers the model exactly the tools a local
// session does, and the same call on the same machine returns the same content and details to the model.

type ModelFacing = Pick<
	ToolDefinition,
	| "name"
	| "label"
	| "description"
	| "parameters"
	| "promptSnippet"
	| "promptGuidelines"
	| "fullPromptGuidelines"
	| "outputSchema"
	| "exposure"
	| "constrainedSampling"
	| "workspaceEffect"
	| "executionMode"
	| "prepareArguments"
>;

const modelFacing = (definition: ModelFacing) =>
	JSON.stringify({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
		fullPromptGuidelines: definition.fullPromptGuidelines,
		outputSchema: definition.outputSchema,
		exposure: definition.exposure,
		constrainedSampling: definition.constrainedSampling,
		workspaceEffect: definition.workspaceEffect,
		executionMode: definition.executionMode,
	});

describe("tools-core definitions", () => {
	const machine = createToolMachine();
	const local = createAllToolDefinitions("/workspace");
	const core: Record<"bash" | "read" | "edit" | "write", ModelFacing> = {
		bash: createCoreBashToolDefinition("/workspace", { machine }),
		read: createCoreReadToolDefinition("/workspace", { machine }),
		edit: createCoreEditToolDefinition("/workspace", { machine }),
		write: createCoreWriteToolDefinition("/workspace", { machine }),
	};

	it.each(["bash", "read", "edit", "write"] as const)("%s exposes the local tool's model-facing fields", (name) => {
		expect(modelFacing(core[name])).toBe(modelFacing(local[name]));
		expect(core[name].prepareArguments).toBe(local[name].prepareArguments);
	});
});

const LONG_OUTPUT = Array.from({ length: 3000 }, (_, index) => `${index + 1}\n`).join("");
const scripts: Record<string, ScriptedExec> = {
	"long output": { output: [{ stream: "stdout", text: LONG_OUTPUT }], exitCode: 0 },
	fails: { output: [{ stream: "stderr", text: "boom\n" }], exitCode: 2 },
	killed: { output: [{ stream: "stdout", text: "partial" }], exitCode: null, signal: "SIGUSR1" },
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tools-core-parity-"));
	vi.stubEnv("TMPDIR", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function seed(cwd: string): void {
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(cwd, "notes.txt"),
		Array.from({ length: 2500 }, (_, i) => `line ${i + 1} \u00e9\u4e2d`).join("\n"),
	);
	writeFileSync(
		join(cwd, "app.js"),
		Array.from({ length: 150 }, (_, i) => `function f${i}() {\n\treturn ${i};\n}`).join("\n"),
	);
	writeFileSync(join(cwd, "edit-me.txt"), "\uFEFFalpha\r\nbeta\r\ngamma\r\n");
	writeFileSync(join(cwd, "same.txt"), "unchanged\n");
}

/** One call's model-facing outcome, with the run directory, spill names and wall time normalized. */
async function outcome<S extends TSchema>(tool: AgentTool<S>, params: Static<S>, cwd: string) {
	let settled: { result: AgentToolResult<unknown> } | { error: string };
	try {
		settled = { result: await tool.execute("call", params) };
	} catch (error) {
		settled = { error: error instanceof Error ? error.message : String(error) };
	}
	const spill =
		"result" in settled
			? /\/[^\s"\]]*pi-bash-[0-9a-f]{16}\.log/.exec(JSON.stringify(settled.result))?.[0]
			: undefined;
	const text = JSON.stringify(settled)
		.split(cwd)
		.join("<CWD>")
		.split(dir)
		.join("<DIR>")
		.replace(/pi-bash-[0-9a-f]{16}\.log/g, "pi-bash-<ID>.log")
		.replace(/"wall_time_seconds":[0-9.]+/, '"wall_time_seconds":0');
	return { text, spill: spill === undefined ? undefined : readFileSync(spill, "utf-8") };
}

function toolsFor(machine: ToolMachine, cwd: string) {
	return {
		core: {
			read: createCoreReadTool(cwd, { machine }),
			bash: createCoreBashTool(cwd, { machine, outputSpill: createMachineOutputSpill(machine, { tempDir: dir }) }),
			write: createCoreWriteTool(cwd, { machine }),
			edit: createCoreEditTool(cwd, { machine }),
		},
		local: {
			read: createReadTool(cwd, { machine }),
			bash: createBashTool(cwd, { machine }),
			write: createWriteTool(cwd, { machine }),
			edit: createEditTool(cwd, { machine }),
		},
	};
}

describe.each(["fs", "op"] as const)("tools-core execution on one fake machine (%s error codes)", (errorCodes) => {
	const run = async <S extends TSchema>(
		pick: (tools: ReturnType<typeof toolsFor>["core"]) => AgentTool<S>,
		params: Static<S>,
	) => {
		const fake = createFakeMachine({ scripts, errorCodes });
		const machine = createToolMachine({ ops: fake });
		const [coreCwd, localCwd] = [join(dir, "core"), join(dir, "local")];
		seed(coreCwd);
		seed(localCwd);
		const core = await outcome(pick(toolsFor(machine, coreCwd).core), params, coreCwd);
		const local = await outcome(pick(toolsFor(machine, localCwd).local), params, localCwd);
		expect(fake.calls.length).toBeGreaterThan(0);
		return { core, local, coreCwd, localCwd };
	};

	it.each([
		["truncated output with a spill", "long output"],
		["a non-zero exit", "fails"],
		["a signal-killed shell", "killed"],
	])("bash returns the local content and details for %s", async (_case, command) => {
		const { core, local } = await run((tools) => tools.bash, { command });
		expect(core.text).toBe(local.text);
		expect(core.spill).toBe(local.spill);
	});

	it.each([
		["offset and limit", { path: "notes.txt", offset: 100, limit: 20 }],
		["head truncation", { path: "notes.txt" }],
		["a folded .js file", { path: "app.js" }],
		["a missing file", { path: "missing.txt" }],
	])("read returns the local content and details for %s", async (_case, params) => {
		const { core, local } = await run((tools) => tools.read, params);
		expect(core.text).toBe(local.text);
	});

	it.each([
		["a new file in a new directory", { path: "out/new.txt", content: "hello\nworld\n" }],
		["an overwrite", { path: "notes.txt", content: "short\n" }],
		["identical content", { path: "same.txt", content: "unchanged\n" }],
	])("write returns the local content and details for %s", async (_case, params) => {
		const { core, local, coreCwd, localCwd } = await run((tools) => tools.write, params);
		expect(core.text).toBe(local.text);
		expect(readFileSync(join(coreCwd, params.path))).toEqual(readFileSync(join(localCwd, params.path)));
	});

	it.each([
		["a BOM and CRLF file", { path: "edit-me.txt", edits: [{ oldText: "beta", newText: "BETA" }] }],
		["text that does not match", { path: "edit-me.txt", edits: [{ oldText: "delta", newText: "DELTA" }] }],
		["a missing file", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }],
	])("edit returns the local content and details for %s", async (_case, params) => {
		const { core, local, coreCwd, localCwd } = await run((tools) => tools.edit, params);
		expect(core.text).toBe(local.text);
		expect(readFileSync(join(coreCwd, "edit-me.txt"))).toEqual(readFileSync(join(localCwd, "edit-me.txt")));
	});
});

describe("tools-core errors across machines", () => {
	it("edit names the same fs code whether the machine passes fs errors through or reports its own", async () => {
		const missing = { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] };
		const texts = [];
		for (const errorCodes of ["fs", "op"] as const) {
			const machine = createToolMachine({ ops: createFakeMachine({ scripts, errorCodes }) });
			const cwd = join(dir, errorCodes);
			seed(cwd);
			texts.push((await outcome(createCoreEditTool(cwd, { machine }), missing, cwd)).text);
		}
		expect(texts[1]).toBe(texts[0]);
		expect(texts[0]).toContain("Error code: ENOENT.");
	});
});

describe("createCoreCodingTools", () => {
	it("returns read, bash, edit and write in createCodingTools order", () => {
		const machine = createToolMachine();
		const tools: CoreCodingTools = createCoreCodingTools("/workspace", { machine });
		expect(tools.map((tool) => tool.name)).toEqual(createCodingTools("/workspace").map((tool) => tool.name));
	});
});

describe("tools-core error codes a machine wraps (senpi#6744)", () => {
	it.each([
		["io_error", "EISDIR"],
		["not_found", "ENOTDIR"],
		["permission_denied", "EPERM"],
	])("edit shows the fs code kept as the cause of a %s error (%s)", async (opCode, fsCode) => {
		const cause = Object.assign(new Error(`${fsCode}: failed`), { code: fsCode });
		const wrapped = Object.assign(new Error("operation failed", { cause }), { code: opCode });
		const edit = createCoreEditTool(dir, {
			machine: createToolMachine({ ops: createFakeMachine({ scripts, errorCodes: "fs" }) }),
			operations: {
				access: () => Promise.reject(wrapped),
				readFile: () => Promise.reject(wrapped),
				writeFile: () => Promise.reject(wrapped),
			},
		});

		await expect(edit.execute("call", { path: "x.txt", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow(
			`Could not edit file: x.txt. Error code: ${fsCode}.`,
		);
	});
});
