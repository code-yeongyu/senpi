// E08 (plan §6.4, G4 + the P0-04a fixture design): detached nested completion() and agent(). O1-O7.
//
// An eval cell holds on a fake-server barrier until it detaches (the project's codemode.json sets a 5 s detach point and
// turns status ticks off), and the turn ends. The case then releases the barrier: the detached cell calls completion()
// (a model request, O1), agent() and agent({handle:true}) (the fixture `task` tool, deterministic ids), and settles;
// its one notification wakes the session for one more model turn (O6, O7).
// A first cell starts the js kernel and settles in the foreground (on_timeout "error" never detaches), and the G4 cell's
// detach point is 5 s: before the kernel runs a cell, the cell waits for the written-files scan of the workspace, and at
// load 39 that pre-run wait passed the old 1 s point in 1 run of 6 (the cell then detached still unstarted). The cell is
// held on the barrier until it detaches either way, so the later point changes nothing the case observes (senpi#7535).
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
						id: "call_warm",
						name: "eval",
						args: { language: "js", summary: "start the js kernel", code: "1", on_timeout: "error" },
					},
				],
			},
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
		writeCodemodeSettings(run.box.cwd, { cellTimeoutSeconds: 5 });
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
