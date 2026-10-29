// E07 (plan §6.4, today): shim args. O1-O7.
//
// Two calls in one batch: one in the legacy shape the shim rewrites, one already valid. The body sees the shimmed
// `{value: 42}` (number), the transcript keeps the model's original arguments, and a third call whose shimmed output
// fails validation never reaches the body.
import { join } from "node:path";
import { FIXTURES } from "./support/case-run.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E07",
	title: "shim args (today)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [join(FIXTURES, "shim-tool.mjs")],
		turns: [
			{ toolCalls: [{ id: "call_legacy", name: "eq_shim", args: { legacy: "42" } }] },
			{ toolCalls: [{ id: "call_valid", name: "eq_shim", args: { value: 7 } }] },
			{ toolCalls: [{ id: "call_bad", name: "eq_shim", args: { value: "bad" } }] },
			{ text: "E07-DONE" },
		],
	},
	async drive(run) {
		await run.open();
		await run.prompt("use eq_shim");
		await run.close();
	},
};
