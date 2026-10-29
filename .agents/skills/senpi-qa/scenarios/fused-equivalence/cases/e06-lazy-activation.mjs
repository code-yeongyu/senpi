// E06 (plan §6.4, today): lazy activation + tool_activated. O1-O7.
//
// The model calls a search-exposed tool that is not active. The lazy activator activates it, the call runs, the
// tool_activated listener records the activation (O5 tree: activation.log), and the next request declares the tool
// (O3) while the first did not.
import { join } from "node:path";
import { FIXTURES } from "./support/case-run.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E06",
	title: "lazy activation + tool_activated (today)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [join(FIXTURES, "lazy-tool.mjs")],
		turns: [{ toolCalls: [{ id: "call_lazy", name: "eq_lazy", args: { value: "on" } }] }, { text: "E06-DONE" }],
	},
	async drive(run) {
		await run.open();
		await run.prompt("use eq_lazy");
		await run.close();
	},
};
