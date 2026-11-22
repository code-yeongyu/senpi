// E02 (plan §6.4, G2): sequential vs parallel interleave. O1-O7.
//
// The CLI has no global sequential switch (the agent loop's `toolExecution` stays "parallel" in coding-agent), so the
// reachable G2 path is a batch of tools that each declare `executionMode: "sequential"`: each body starts only after
// the previous one finished. O5 records, per release, which bodies were in flight: always just the one released.
import { HELD_TOOLS, promptHeld, releaseInOrder } from "./support/held.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const STEPS = [1, 2, 3].map((n) => ({ toolCallId: `seq_${n}`, barrier: `seq-${n}`, path: `out/seq-${n}.txt` }));

export default {
	id: "E02",
	title: "global sequential (G2)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [
			{
				toolCalls: STEPS.map(({ toolCallId, barrier, path }) => ({
					id: toolCallId,
					name: "eq_seq",
					args: { path, text: `${toolCallId}\n`, barrier },
				})),
			},
			{ text: "E02-DONE" },
		],
	},
	async drive(run) {
		await run.open();
		const { arrived, idle } = await promptHeld(run, "write three files one at a time", STEPS);
		await releaseInOrder(run, arrived, STEPS);
		await idle;
		await run.close();
	},
};
