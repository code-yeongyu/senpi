// E05 (plan §6.4, today): a later preflight abort vetoes every body. O1-O7.
//
// One batch of three held writes; the preflight (tool_call) handler aborts while the third call is prepared. Today the
// executor assigns dependencies only after every preflight ran, so no body starts: no barrier is ever reached, no file
// is written (O5), and every call ends with today's aborted result (O6/O7). A regression that let an earlier body run
// would hang on its barrier and fail the case at the turn timeout.
import { join } from "node:path";
import { FIXTURES } from "./support/case-run.mjs";
import { HELD_TOOLS } from "./support/held.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E05",
	title: "later preflight abort vetoes every body (today)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [HELD_TOOLS, join(FIXTURES, "preflight-abort.mjs")],
		files: { "out/.keep": "" },
		turns: [
			{
				toolCalls: [1, 2, 3].map((n) => ({
					id: `call_x${n}`,
					name: "eq_write",
					args: { path: `out/x${n}.txt`, text: `x${n}\n`, barrier: `veto-${n}` },
				})),
			},
			{ text: "E05-AFTER" },
		],
	},
	async drive(run) {
		await run.open();
		await run.prompt("write three files");
		await run.close();
	},
};
