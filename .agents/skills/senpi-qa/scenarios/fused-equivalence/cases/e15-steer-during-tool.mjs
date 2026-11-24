// E15 (plan §6.4, B5): steer during a tool. O1-O7.
//
// A write is held on its barrier; the RPC client steers; the case then releases the write. Today the steer is queued
// and delivered after the tool result, in the same run's next request (O1), never as a separate turn.
import { HELD_TOOLS } from "./support/held.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E15",
	title: "steer during a tool (B5)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [
			{
				toolCalls: [
					{
						id: "call_steered",
						name: "eq_write",
						args: { path: "out/steered.txt", text: "call_steered\n", barrier: "steer-1" },
					},
				],
			},
			{ text: "E15-AFTER-STEER" },
		],
	},
	async drive(run) {
		await run.open();
		const idle = run.nextEvent((e) => e.type === "agent_idle");
		await run.send({ type: "prompt", message: "write a file" });
		await run.server.barrierArrived("steer-1");
		await run.send({ type: "steer", message: "E15 steer: also mention the file name" });
		const ended = run.nextEvent((e) => e.type === "tool_execution_end" && e.toolCallId === "call_steered");
		run.server.releaseBarrier("steer-1");
		await ended;
		await idle;
		await run.close();
	},
};
