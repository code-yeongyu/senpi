// E16 (plan §6.4, X6): bash wake. O1-O7.
//
// Turn 1 starts a background bash through an eval cell (`bash` is eval-exposed in the CLI); its command blocks on a
// fake-server barrier, so the case decides when it finishes. The turn ends and the session goes idle. The case then
// releases the barrier: the background session finishes while the session is idle and today's terminal extension
// wakes it once with a hidden notice carrying the exit status and output tail, which starts one model turn (O1, O6,
// O7) with no synthetic user message.
import { WITHOUT_O8 } from "./support/observables.mjs";

const WAITER = 'curl -s "$EQ_BARRIER_ORIGIN/__barrier/wake-1" && echo X6_WAKE_TAIL';

export default {
	id: "E16",
	title: "bash wake (X6)",
	observables: WITHOUT_O8,
	spec: {
		env: { SENPI_PTY_FORCE_PIPE: "1" },
		turns: [
			{
				toolCalls: [
					{
						id: "call_bg",
						name: "eval",
						args: {
							language: "js",
							summary: "start the background waiter",
							code: `const started = await tool.bash({ command: ${JSON.stringify(WAITER)}, run_in_background: true });\nprint(started.text);`,
						},
					},
				],
			},
			{ text: "E16-STARTED" },
			{ text: "E16-WOKE" },
		],
	},
	async drive(run) {
		await run.open();
		await run.prompt("start the waiter in the background");
		await run.server.barrierArrived("wake-1");
		const wakeIdle = run.nextEvent((e) => e.type === "agent_idle");
		const wakeStart = run.nextEvent((e) => e.type === "agent_start");
		run.server.releaseBarrier("wake-1");
		await wakeStart;
		await wakeIdle;
		await run.close();
	},
};
