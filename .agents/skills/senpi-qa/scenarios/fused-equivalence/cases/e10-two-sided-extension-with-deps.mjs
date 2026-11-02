// E10 (plan §6.4, P0-02b fixture): multi-turn two-sided extension + with-deps. O1-O7.
//
// Two unmodified extensions loaded by path: the G5 closure fixture (test/fixtures/closure-ext: before_agent_start,
// tool_call and tool_result share one closure) and the shipped examples/extensions/with-deps (its own npm dependency,
// `ms`). Two prompts each call parse_duration; the closure's counter shows in each turn's system prompt (O1), in the
// tool input (O6/O7) and in the result details.
import { join } from "node:path";
import { repoRoot } from "../../../scripts/lib/common.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

export default {
	id: "E10",
	title: "multi-turn two-sided extension + with-deps",
	observables: WITHOUT_O8,
	spec: (repo = repoRoot()) => ({
		extensions: [
			join(repo, "packages", "coding-agent", "test", "fixtures", "closure-ext", "index.ts"),
			join(repo, "packages", "coding-agent", "examples", "extensions", "with-deps"),
		],
		turns: [
			{ toolCalls: [{ id: "call_d1", name: "parse_duration", args: { duration: "2 days" } }] },
			{ text: "E10-FIRST" },
			{ toolCalls: [{ id: "call_d2", name: "parse_duration", args: { duration: "1h" } }] },
			{ text: "E10-SECOND" },
		],
	}),
	async drive(run) {
		await run.open();
		await run.prompt("how long is 2 days");
		await run.prompt("and 1h");
		await run.close();
	},
};
