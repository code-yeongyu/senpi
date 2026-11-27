// E20 (plan §6.4): detached kill notice. O1-O7.
//
// An eval cell holds on a fake-server barrier that is never released. It detaches at the project's 1 s detach point and
// the turn ends. The cell's wall-clock hard limit (3 s, codemode.json) then kills it while the session is idle, and
// today's one notification ("Detached eval cell ... was killed at the 3s hard limit") wakes the session for one model
// turn (O1, O6, O7).
import { writeCodemodeSettings } from "./support/codemode.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const CELL =
	'await fetch(process.env.EQ_BARRIER_ORIGIN + "/__barrier/never-released").then((r) => r.text());\nprint("unreachable");';

export default {
	id: "E20",
	title: "detached kill notice",
	observables: WITHOUT_O8,
	spec: {
		turns: [
			{
				toolCalls: [
					{
						id: "call_doomed",
						name: "eval",
						args: { language: "js", summary: "a cell that never finishes", code: CELL },
					},
				],
			},
			{ text: "E20-WAITING" },
			{ text: "E20-NOTICED" },
		],
	},
	async drive(run) {
		writeCodemodeSettings(run.box.cwd, { cellTimeoutSeconds: 1, hardLimitSeconds: 3 });
		await run.open();
		const wakeStart = run.nextEvent(
			(e) => e.type === "agent_start" && run.client.events.some((x) => x.type === "agent_idle"),
		);
		await run.prompt("run the cell");
		await wakeStart;
		const wakeIdle = run.nextEvent((e) => e.type === "agent_idle");
		await wakeIdle;
		await run.close();
	},
};
