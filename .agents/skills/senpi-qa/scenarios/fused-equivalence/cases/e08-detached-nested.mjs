// E08 (plan §6.4, G4 + the P0-04a fixture design): detached nested completion() and agent(). O1-O7.
//
// An eval cell holds on a fake-server barrier until it detaches (the project's codemode.json sets a 1 s detach point and
// turns status ticks off), and the turn ends. The case then releases the barrier: the detached cell calls completion()
// (a model request, O1), agent() and agent({handle:true}) (the fixture `task` tool, deterministic ids), and settles;
// its one notification wakes the session for one more model turn (O6, O7).
import { join } from "node:path";
import { FIXTURES } from "./support/case-run.mjs";
import { writeCodemodeSettings } from "./support/codemode.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const CELL = [
	'await fetch(process.env.EQ_BARRIER_ORIGIN + "/__barrier/g4-detach").then((r) => r.text());',
	'const reply = await completion("G4 completion prompt");',
	'const answer = await agent("G4 agent prompt");',
	'const handle = await agent({ prompt: "G4 handle prompt", handle: true });',
	"print(JSON.stringify({ reply, answer, handle }));",
].join("\n");

export default {
	id: "E08",
	title: "detached nested (G4)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [join(FIXTURES, "task-tool.mjs")],
		turns: [
			{
				toolCalls: [
					{
						id: "call_g4",
						name: "eval",
						args: { language: "js", summary: "G4 detached nested calls", code: CELL },
					},
				],
			},
			{ text: "E08-WAITING" },
			{ text: "E08-COMPLETION-REPLY" },
			{ text: "E08-WOKE" },
		],
	},
	async drive(run) {
		writeCodemodeSettings(run.box.cwd, { cellTimeoutSeconds: 1 });
		await run.open();
		await run.prompt("run the G4 cell");
		const wakeStart = run.nextEvent((e) => e.type === "agent_start");
		const wakeIdle = run.nextEvent((e) => e.type === "agent_idle");
		run.server.releaseBarrier("g4-detach");
		await wakeStart;
		await wakeIdle;
		await run.close();
	},
};
