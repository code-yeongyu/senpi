// E01 (plan §6.4): three reads in one assistant turn run as one parallel batch. O1-O8.
//
// Each read is held on its own barrier: the case waits until all three bodies are in flight at once (the batch is
// parallel, recorded in O5), then lets them finish in a fixed order, so completion order and every event after it are
// deterministic.
import { allArrived, HELD_TOOLS, promptHeld, releaseInOrder } from "./support/held.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

const STEPS = [
	{ toolCallId: "call_a", path: "a.txt", barrier: "read-a" },
	{ toolCallId: "call_b", path: "b.txt", barrier: "read-b" },
	{ toolCallId: "call_c", path: "c.txt", barrier: "read-c" },
];

export default {
	id: "E01",
	title: "3 parallel reads",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "a.txt": "alpha\n", "b.txt": "bravo\n", "c.txt": "charlie\n" },
		turns: [
			{
				toolCalls: STEPS.map(({ toolCallId, path, barrier }) => ({
					id: toolCallId,
					name: "eq_read",
					args: { path, barrier },
				})),
			},
			{ text: "E01-DONE" },
		],
	},
	async drive(run) {
		await run.open();
		const { arrived, idle } = await promptHeld(run, "read a.txt, b.txt and c.txt", STEPS);
		await allArrived(
			run,
			STEPS.map((step) => step.barrier),
		);
		await releaseInOrder(run, arrived, STEPS);
		await idle;
		await run.close();
		await run.reopenState();
	},
};
