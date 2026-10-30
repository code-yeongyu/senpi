// E14 (plan §6.4, B21): kill + resume + continue. O1-O8.
//
// The child is SIGKILLed while a write is held on its barrier (a dispatched body in flight). The session is reopened
// from disk in a new child (same durable id, O7), a follow-up prompt continues it (today's recovery gives the dangling
// call its placeholder result before the next request, O1), and a headless reopen reads the final state (O8).
import { HELD_TOOLS } from "./support/held.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

export default {
	id: "E14",
	title: "kill + resume + continue (B21)",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [
			{
				toolCalls: [
					{
						id: "call_killed",
						name: "eq_write",
						args: { path: "out/killed.txt", text: "call_killed\n", barrier: "kill-1" },
					},
				],
			},
			{ text: "E14-RESUMED" },
		],
	},
	async drive(run) {
		await run.open();
		await run.send({ type: "prompt", message: "write a file" });
		await run.server.barrierArrived("kill-1");
		await run.kill();
		await run.open({ resume: true });
		await run.prompt("continue");
		await run.close();
		await run.reopenState();
	},
};
