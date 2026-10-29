// E12 (plan §6.4, B19): compaction + veto. O1-O8.
//
// Three turns, then an RPC compact that the extension vetoes (the command fails, nothing is summarized), then a second
// compact the extension allows: the summary request goes to the model (O1) and the transcript gains the compaction
// entry (O7). A headless reopen reads the compacted session (O8).
import { join } from "node:path";
import { FIXTURES } from "./support/case-run.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

export default {
	id: "E12",
	title: "compaction + veto (B19)",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [join(FIXTURES, "compact-veto.mjs")],
		// Keep almost nothing recent, so a three-turn session has turns old enough to summarize.
		settings: { compaction: { keepRecentTokens: 1 } },
		turns: [
			{ text: "E12-FIRST" },
			{ text: "E12-SECOND" },
			{ text: "E12-THIRD" },
			{ text: "E12-SUMMARY of the conversation" },
		],
	},
	async drive(run) {
		await run.open();
		await run.prompt("first");
		await run.prompt("second");
		await run.prompt("third");
		const vetoed = await run.client.send({ type: "compact" }, { timeoutMs: 120_000 });
		run.effects.push({ compact: 1, success: vetoed.success, error: vetoed.error ?? null });
		const allowed = await run.client.send({ type: "compact" }, { timeoutMs: 120_000 });
		run.effects.push({ compact: 2, success: allowed.success, error: allowed.error ?? null });
		await run.close();
		await run.reopenState();
	},
};
