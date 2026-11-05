// E03 (plan §6.4, G3): per-tool waves. O1-O7.
//
// One batch [w1, w2, s3, w4, w5]: w* are parallel, s3 declares executionMode "sequential". Today that runs as waves:
// {w1, w2} together, then s3 alone after both, then {w4, w5} together after s3. Barriers pin each wave (no timers);
// O5 records which bodies were in flight at every release.
import { allArrived, HELD_TOOLS, promptHeld, releaseInOrder } from "./support/held.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const CALLS = [
	["w1", "eq_write"],
	["w2", "eq_write"],
	["s3", "eq_seq"],
	["w4", "eq_write"],
	["w5", "eq_write"],
].map(([name, tool]) => ({ toolCallId: `call_${name}`, barrier: `wave-${name}`, path: `out/${name}.txt`, tool }));
const wave = (...names) => CALLS.filter((call) => names.some((name) => call.toolCallId === `call_${name}`));

export default {
	id: "E03",
	title: "per-tool waves (G3)",
	observables: WITHOUT_O8,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [
			{
				toolCalls: CALLS.map(({ toolCallId, barrier, path, tool }) => ({
					id: toolCallId,
					name: tool,
					args: { path, text: `${toolCallId}\n`, barrier },
				})),
			},
			{ text: "E03-DONE" },
		],
	},
	async drive(run) {
		await run.open();
		const { arrived, idle } = await promptHeld(run, "write five files in waves", CALLS);
		for (const steps of [wave("w1", "w2"), wave("s3"), wave("w4", "w5")]) {
			await allArrived(
				run,
				steps.map((step) => step.barrier),
			);
			await releaseInOrder(run, arrived, steps);
		}
		await idle;
		await run.close();
	},
};
