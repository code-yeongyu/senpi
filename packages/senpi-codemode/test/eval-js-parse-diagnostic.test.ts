import { expect, it, vi } from "vitest";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";
import { withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

it("locates malformed shell interpolation in the submitted JS cell without running it", async () => {
	await withJavaScriptKernel(async (kernel) => {
		const executeTool = vi.fn();
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: { getKernel: async () => kernel },
			cellTimeoutSeconds: 30,
			executeTool,
		});
		const run = (code: string) =>
			tool.execute(
				crypto.randomUUID(),
				{ language: "js", code, summary: "syntax diagnostic" },
				undefined,
				undefined,
				fakeExtensionContext(),
			);
		const shellLine = `print('\${sample:-fixture}')`;
		const failed = await run(
			["globalThis.ranBrokenCell = true;", "const cmd = `python3 - <<'PY'", shellLine, "PY`;"].join("\n"),
		);
		expect(failed.details.isError).toBe(true);
		expect(failed.content[0]).toMatchObject({
			text: expect.stringContaining(`line 3, column 16:\n${shellLine}\n               ^`),
		});
		expect(failed.content[0]).toMatchObject({ text: expect.stringContaining("shell heredoc") });
		expect((await run("typeof globalThis.ranBrokenCell")).content[0]).toMatchObject({
			text: expect.stringContaining("undefined"),
		});
		expect((await run('throw new SyntaxError("runtime sentinel")')).content[0]).toMatchObject({
			text: "runtime sentinel",
		});
		expect(executeTool).not.toHaveBeenCalled();
	});
});
