// E18 (plan §6.4, B6): nested ctx.executeTool. O1-O7.
//
// The model calls eq_nested, whose body runs the built-in read through ctx.executeTool. The nested call goes through
// today's hook pipeline (its tool_hook_status events, O6) and its text comes back inside the outer result (O1, O7).
import { join } from "node:path";
import { FIXTURES } from "./support/case-run.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E18",
	title: "nested ctx.executeTool (B6)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [join(FIXTURES, "nested-tool.mjs")],
		files: { "n.txt": "nested-content\n" },
		turns: [{ toolCalls: [{ id: "call_outer", name: "eq_nested", args: { path: "n.txt" } }] }, { text: "E18-DONE" }],
	},
	async drive(run) {
		await run.open();
		await run.prompt("read n.txt through eq_nested");
		await run.close();
	},
};
