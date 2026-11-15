import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodingTools } from "../../src/core/tools/index.ts";
import { createToolMachine } from "../../src/core/tools/machine.ts";
import { createCoreCodingTools, createMachineOutputSpill } from "../../src/tools-core.ts";

// Public API contract of the tools-core entry: run through a ToolMachine, the cores return what the local tools return.
let dir: string;
let core: Record<string, AgentTool<any>>;
let local: Record<string, AgentTool<any>>;

const byName = (tools: AgentTool<any>[]) => Object.fromEntries(tools.map((tool) => [tool.name, tool]));
const run = (tool: AgentTool<any> | undefined, params: Record<string, unknown>) => {
	if (tool === undefined) throw new Error("tool missing");
	return tool.execute("call", params, undefined, undefined);
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tools-core-"));
	// The local bash spills under os.tmpdir(); keep its files out of the shared temp dir other suites inspect.
	vi.stubEnv("TMPDIR", dir);
	const machine = createToolMachine();
	core = byName(
		createCoreCodingTools(dir, {
			machine,
			bash: { outputSpill: createMachineOutputSpill(machine, { tempDir: dir }), exposeSessionEnvironment: false },
		}),
	);
	local = byName(createCodingTools(dir, { bash: { exposeSessionEnvironment: false } }));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("core tools over a ToolMachine", () => {
	it("read returns the local text, truncation notice and details", async () => {
		const lines = Array.from({ length: 2500 }, (_, index) => `line ${index + 1} \u00e9`);
		writeFileSync(join(dir, "big.txt"), `\uFEFF${lines.join("\n")}`);

		for (const params of [{ path: "big.txt" }, { path: "big.txt", offset: 2400, limit: 50 }]) {
			expect(await run(core.read, params)).toEqual(await run(local.read, params));
		}
	});

	it("write and edit leave the bytes and return the results the local tools do", async () => {
		const content = "alpha\r\nbeta\r\ngamma\r\n";
		const written = [
			await run(core.write, { path: "core.txt", content }),
			await run(local.write, { path: "local.txt", content }),
		];
		expect(written[0]?.content).toEqual([{ type: "text", text: "Successfully wrote to core.txt" }]);
		expect(written[1]?.content).toEqual([{ type: "text", text: "Successfully wrote to local.txt" }]);
		expect(written[0]?.details).toEqual({
			...written[1]?.details,
			patch: written[1]?.details.patch.replaceAll("local.txt", "core.txt"),
		});

		const edits = [{ oldText: "beta", newText: "BETA" }];
		const edited = await run(core.edit, { path: "core.txt", edits });
		const localEdited = await run(local.edit, { path: "local.txt", edits });
		expect(edited.details).toEqual({
			...localEdited.details,
			patch: localEdited.details.patch.replaceAll("local.txt", "core.txt"),
		});
		expect(readFileSync(join(dir, "core.txt"))).toEqual(readFileSync(join(dir, "local.txt")));
	});

	it("bash returns the local output and keeps the full output in a file on the machine", async () => {
		const command = "seq 1 3000";
		const result = await run(core.bash, { command });
		const localResult = await run(local.bash, { command });

		expect(result.content[0]).toEqual(localResult.content[0]);
		const fullOutputPath = result.details.fullOutputPath;
		expect(fullOutputPath?.startsWith(`${dir}/pi-bash-`)).toBe(true);
		const localNotice = localResult.content[1];
		if (localNotice?.type !== "text") throw new Error("local bash returned no truncation notice");
		expect(result.content[1]).toEqual({
			...localNotice,
			text: localNotice.text.replace(localResult.details.fullOutputPath, fullOutputPath),
		});
		expect(readFileSync(fullOutputPath, "utf-8")).toBe(readFileSync(localResult.details.fullOutputPath, "utf-8"));
		expect(result.structuredContent).toMatchObject({ exit_code: 0, truncated: false });
	});
});
