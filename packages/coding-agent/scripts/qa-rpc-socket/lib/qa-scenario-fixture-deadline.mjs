/**
 * `6-fixture-deadline` (senpi#3566 todo 6): run with `--env SENPI_TOOL_CHILD_DEADLINE_QA_SLEEP_MS=3000` and
 * `--expect-failure tool_child_deadline`. (The plan's 50 ms is shorter than a module job's cold start - worker start plus
 * module import - so the follow-up call could never fit; 3000 ms keeps the same logic with room for it.) The scripted
 * model calls `qa_sleep{ms:30000}`; the server's backstop rejects it
 * with `tool_child_deadline`. The model then calls `qa_sleep{ms:10}`, which must succeed on the SAME tool child
 * (generation and pid unchanged, no `exited` record): the deadline ends the job, never the child. The scenario then
 * throws the deadline failure it observed, so the driver records `expected_failure` against it.
 */
import { QaFailure } from "./qa-failure.mjs";

const STEPS = [
	{ tool: "qa_sleep", args: { ms: 30_000 } },
	{ tool: "qa_sleep", args: { ms: 10 } },
	{ text: "deadline checked" },
];

function assert(condition, message) {
	if (!condition) throw new QaFailure("assertion_failed", message);
}

async function toolChildRow(ctx, sessionId) {
	const listed = await ctx.rpc.request({ type: "list_sessions" });
	const rows = listed?.data?.sessions ?? listed?.sessions ?? [];
	return rows.find((row) => row.sessionId === sessionId || row.id === sessionId)?.tool_child;
}

export const fixtureDeadlineScenario = Object.freeze({
	id: "6-fixture-deadline",
	requires: [4, 6],
	needsExtension: true,
	model(body) {
		const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool").length;
		return STEPS[Math.min(toolMessages, STEPS.length - 1)];
	},
	async run(ctx) {
		const sessionId = await ctx.openSession();
		const ends = [];
		const childRecords = [];
		ctx.rpc.subscribe((r) => {
			if (r.sessionId !== sessionId) return;
			if (r.type === "tool_execution_end" && r.toolName === "qa_sleep") ends.push(r);
			if (r.type === "session_tool_child") childRecords.push(r);
		});
		const settled = ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "agent_settled", {
			name: "agent_settled",
			deadlineMs: 120_000,
		});
		await ctx.prompt(sessionId, "sleep past the deadline, then briefly");
		await settled;
		ctx.log.write({ type: "tool_ends", ends: ends.map((end) => ({ isError: end.isError === true, text: JSON.stringify(end.result?.content ?? null).slice(0, 300) })) });
		ctx.log.write({ type: "child_records", records: childRecords.map((r) => ({ state: r.state, generation: r.generation, pid: r.pid })) });
		assert(ends.length === 2, `expected two qa_sleep results, saw ${ends.length}`);
		const [late, quick] = ends;
		const lateText = JSON.stringify(late.result?.content ?? "");
		assert(late.isError === true && lateText.includes("tool_child_deadline"), `the long sleep did not end at its deadline: ${lateText.slice(0, 300)}`);
		assert(quick.isError !== true, `the follow-up sleep failed: ${JSON.stringify(quick.result?.content ?? "").slice(0, 300)}`);
		assert(!childRecords.some((r) => r.state === "exited"), "the tool child exited: a deadline must end the job, not the child");
		const spawns = childRecords.filter((r) => r.state === "spawned" || r.state === "respawned");
		assert(spawns.length === 1, `expected exactly one child spawn, saw ${spawns.length}`);
		const row = await toolChildRow(ctx, sessionId);
		ctx.log.write({ type: "tool_child_row", row: row ?? null });
		assert(row?.state === "live" && row.generation === spawns[0].generation && row.pid === spawns[0].pid, `the child is not the one that ran the job: ${JSON.stringify(row)}`);
		throw new QaFailure("tool_child_deadline", "the long qa_sleep ended at its 3000 ms deadline; the same child served the next call");
	},
});
