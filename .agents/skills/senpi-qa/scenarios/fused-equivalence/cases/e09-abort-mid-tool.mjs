// E09 (plan §6.4): abort mid-tool. O1-O8.
//
// A write is held on its barrier (its body is in flight); the RPC client aborts. The body's fetch is cancelled through
// the tool's abort signal, nothing is written (O5), the turn ends without another model request (O1), and the
// transcript records today's aborted result (O7); a headless reopen reads the settled state (O8).
import { HELD_TOOLS } from "./support/held.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

export default {
	id: "E09",
	title: "abort mid-tool",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [
			{
				toolCalls: [
					{
						id: "call_abort",
						name: "eq_write",
						args: { path: "out/aborted.txt", text: "call_abort\n", barrier: "abort-1" },
					},
				],
			},
			{ text: "E09-NEVER" },
		],
	},
	async drive(run) {
		await run.open();
		const idle = run.nextEvent((e) => e.type === "agent_idle");
		await run.send({ type: "prompt", message: "write a file" });
		await run.server.barrierArrived("abort-1");
		const ended = run.nextEvent((e) => e.type === "tool_execution_end" && e.toolCallId === "call_abort");
		await run.send({ type: "abort" });
		await ended;
		await idle;
		await run.close();
		await run.reopenState();
	},
};
