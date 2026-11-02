/**
 * Todo 8 scenarios (senpi#3566), driven with `test/fixtures/qa-offload-extension.ts`, which offloads `qa-whoami` at
 * session_start and appends the outcome as a `qa_offload_result` custom entry.
 *
 * `8-offload-session-start` (`--runtime child`): the session's tool child is spawned and the module's result comes from
 * a pid other than the server's.
 * `8-offload-legacy-no-child` (`--runtime in-process`): the result comes from the server's own pid, no
 * `session_tool_child` record is emitted, and the session's `list_sessions` row reports `tool_child.state === "none"`.
 */
import { QaFailure } from "./qa-failure.mjs";

/**
 * The session's qa_offload_result entry. It may be appended before open_session returns (in-process, the module runs at
 * once during session_start), so the entries already in the session are read too; otherwise its entry_appended record.
 */
async function offloadResult(ctx, sessionId) {
	const appended = ctx.awaitRecord(
		(r) => r.sessionId === sessionId && r.type === "entry_appended" && r.entry?.customType === "qa_offload_result",
		{ name: "qa_offload_result entry", deadlineMs: 90_000 },
	);
	const listed = await ctx.rpc.request({ type: "get_entries", sessionId });
	const existing = (listed.data?.entries ?? []).find((entry) => entry.customType === "qa_offload_result");
	if (existing === undefined) return appended;
	appended.catch(() => undefined);
	ctx.log.write({ type: "step", step: "result_entry_already_appended" });
	return { entry: existing };
}

function outcomeOf(record) {
	const data = record.entry?.data;
	if (data?.ok !== true) throw new QaFailure("assertion_failed", `offload failed: ${JSON.stringify(data)}`);
	return data;
}

export const offloadSessionStartScenario = Object.freeze({
	id: "8-offload-session-start",
	requires: [4, 8],
	needsExtension: true,
	async run(ctx) {
		const spawned = ctx.awaitRecord((r) => r.type === "session_tool_child" && r.state === "spawned", {
			name: "session_tool_child spawned",
			deadlineMs: 90_000,
		});
		const sessionId = await ctx.openSession();
		const [spawnRecord, resultRecord] = await Promise.all([spawned, offloadResult(ctx, sessionId)]);
		const data = outcomeOf(resultRecord);
		ctx.log.write({
			type: "assert",
			childPid: spawnRecord.pid,
			resultPid: data.result.pid,
			serverPid: data.serverPid,
			from: data.result.from,
		});
		if (data.result.pid === data.serverPid)
			throw new QaFailure("assertion_failed", "the offloaded module ran in the server process");
		if (data.result.pid !== spawnRecord.pid)
			throw new QaFailure("assertion_failed", `result pid ${data.result.pid} is not the spawned child ${spawnRecord.pid}`);
	},
});

export const offloadLegacyNoChildScenario = Object.freeze({
	id: "8-offload-legacy-no-child",
	requires: [8],
	needsExtension: true,
	async run(ctx) {
		const childRecords = [];
		ctx.rpc.subscribe((record) => {
			if (record.type === "session_tool_child") childRecords.push(record);
		});
		const sessionId = await ctx.openSession();
		const data = outcomeOf(await offloadResult(ctx, sessionId));
		const listed = await ctx.rpc.request({ type: "list_sessions" });
		const row = (listed.data?.sessions ?? []).find((candidate) => candidate.sessionId === sessionId);
		ctx.log.write({
			type: "assert",
			resultPid: data.result.pid,
			serverPid: data.serverPid,
			toolChild: row?.tool_child ?? null,
			sessionToolChildRecords: childRecords.length,
		});
		if (data.result.pid !== data.serverPid)
			throw new QaFailure("assertion_failed", `in-process offload ran in pid ${data.result.pid}, not the server`);
		if (row?.tool_child?.state !== "none")
			throw new QaFailure("assertion_failed", `tool_child row is ${JSON.stringify(row?.tool_child)}`);
		if (childRecords.length > 0) throw new QaFailure("assertion_failed", "a session_tool_child record was emitted");
	},
});
