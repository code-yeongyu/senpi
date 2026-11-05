// E25 (plan §6.4, X13, Z1.a): kill recovery on the fused path equals today. O1-O8.
//
// One persisted session, four kills, each followed by a reopen from disk in a new child (same durable id, O7). The four
// kill points are X13's scenarios (packages/coding-agent/test/characterization/crash-recovery-today.test.ts) driven
// through the real CLI:
// 1. dispatched-body: SIGKILL while one `eq_ledger` body is held on its barrier;
// 2. unreleased-siblings: a batch of two; the first body finishes (its tool_execution_end is seen) while the second is
//    still held, then SIGKILL;
// 3. pending-question: SIGKILL while `ask_user_question` (waitForAnswer) waits for its answer; on resume the question is
//    asked again (a new select dialog on the new child) and answered, and the answer starts the next turn;
// 4. unparseable-question: a child that also loads fixtures/e25/stale-question.mjs records an `ask_user_question` call
//    with arguments that do not form a question and is killed in its body; the resumed session (in a child without that
//    fixture) settles it `orphaned-after-restart`; the settlement is held as a notice while the session is paused on its
//    interrupted run, and the next prompt delivers it.
// Kills 1 and 2 reopen the session the way a restarted CLI does (`--session <file>`, session_start reason `startup`).
// Kills 3 and 4 resume it the way a running client does (a fresh child, then RPC `switch_session` to the file: reason
// `resume`), the path on which today's ask-user extension restores a dangling question
// (packages/coding-agent/src/core/extensions/builtin/ask-user/resume.ts; a `startup` open does not restore it).
// X13 says "re-asked on resume"; that a restarted CLI opening the file with `--session` does NOT re-ask is a bug,
// https://github.com/code-yeongyu/senpi/issues/4764. B0 records today's behavior until it is fixed.
// After every kill the case releases the killed barriers, so a body that ran again on resume would run to completion:
// its id would be appended to ledger.txt a second time and its file written (O5 tree), and its start event would be an
// extra O5 call. Today's recovery gives each dangling call the placeholder result in the next request (O1), runs no tool
// again, and resumes the question as above (O6/O7). A final headless reopen reads the state (O8).
import { join } from "node:path";
import { RpcClient } from "../../../scripts/lib/rpc-client.mjs";
import { FIXTURES } from "./support/case-run.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

const LEDGER_TOOLS = join(FIXTURES, "e25", "ledger-tools.mjs");
const STALE_QUESTION = join(FIXTURES, "e25", "stale-question.mjs");

const ledger = (id, barrier) => ({ id, name: "eq_ledger", args: { barrier } });
const QUESTION_ARGS = {
	questions: [
		{
			header: "Library",
			question: "Which library?",
			options: [{ label: "alpha" }, { label: "beta" }],
			multiSelect: false,
		},
	],
	waitForAnswer: true,
};
const isQuestionDialog = (event) =>
	event.type === "extension_ui_request" && event.method === "select" && event.title?.includes("Which library?");

/** SIGKILL the current child, release the barriers its bodies were held on, and reopen the session from disk. */
async function killAndReopen(run, barriers) {
	await run.kill();
	for (const barrier of barriers) run.server.releaseBarrier(barrier);
	return run.open({ resume: true });
}

/**
 * Resume the persisted session in a fresh child through RPC `switch_session`, as a running client resumes one. The child's
 * own startup session is never prompted, and only the resumed session's id is recorded (O7 durable id).
 */
async function resumeBySwitch(run) {
	const client = new RpcClient({ env: run.env, cwd: run.box.cwd, extraArgs: run.args });
	run.clients.push(client);
	const ready = await client.send({ type: "get_state" }, { timeoutMs: 300_000 });
	if (!ready.success) throw new Error(`get_state failed: ${JSON.stringify(ready).slice(0, 400)}`);
	const switched = await run.send({ type: "switch_session", sessionPath: run.sessionFile });
	if (switched.data?.cancelled) throw new Error("switch_session was cancelled");
	const state = await run.send({ type: "get_state" });
	run.sessionIds.push(state.data.sessionId);
	return client;
}

export default {
	id: "E25",
	title: "kill during a dispatched body, with unreleased siblings, and with a pending question; today's recovery (X13)",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [LEDGER_TOOLS],
		files: { "ledger.txt": "" },
		turns: [
			{ toolCalls: [ledger("call_body", "kill-body")] },
			{ text: "E25-BODY-RESUMED" },
			{ toolCalls: [ledger("call_sibling_done", "sibling-done"), ledger("call_sibling_held", "sibling-held")] },
			{ text: "E25-SIBLINGS-RESUMED" },
			{ toolCalls: [{ id: "call_question", name: "ask_user_question", args: QUESTION_ARGS }] },
			{ text: "E25-QUESTION-ANSWERED" },
			{ toolCalls: [{ id: "call_question_bad", name: "ask_user_question", args: {} }] },
			{ text: "E25-QUESTION-ORPHANED" },
		],
	},
	async drive(run) {
		// 1. dispatched-body
		await run.open();
		await run.send({ type: "prompt", message: "run the held body" });
		await run.server.barrierArrived("kill-body");
		await killAndReopen(run, ["kill-body"]);
		await run.prompt("continue after the first crash");

		// 2. unreleased-siblings
		const done = run.nextEvent((e) => e.type === "tool_execution_end" && e.toolCallId === "call_sibling_done");
		await run.send({ type: "prompt", message: "run the batch" });
		await Promise.all([run.server.barrierArrived("sibling-done"), run.server.barrierArrived("sibling-held")]);
		run.server.releaseBarrier("sibling-done");
		await done;
		await killAndReopen(run, ["sibling-held"]);
		await run.prompt("continue after the second crash");

		// 3. pending-question: asked, killed while waiting, asked again on reopen, answered.
		const asked = run.nextEvent(isQuestionDialog);
		await run.send({ type: "prompt", message: "ask me which library" });
		await asked;
		await run.kill();
		await resumeBySwitch(run);
		const reasked = await run.client.waitForEvent(isQuestionDialog, { timeoutMs: 120_000 });
		const answered = run.nextEvent((e) => e.type === "agent_idle");
		await run.send({ type: "extension_ui_response", id: reasked.id, value: "alpha" });
		await answered;

		// 4. unparseable-question: only this child loads the stand-in tool.
		await run.close();
		const baseArgs = run.args;
		run.args = [...baseArgs, "--extension", STALE_QUESTION];
		await run.open({ resume: true });
		run.args = baseArgs;
		await run.send({ type: "prompt", message: "ask me something" });
		await run.server.barrierArrived("stale-question");
		await run.kill();
		run.server.releaseBarrier("stale-question");
		// The settlement arrives while the resumed session is paused on its interrupted run, so it is held as a session
		// notice (today's "send a message to continue"); the wait accepts a notice the child reported during the switch.
		await resumeBySwitch(run);
		await run.client.waitForEvent((e) => e.type === "session_notice", { timeoutMs: 120_000 });
		await run.prompt("continue after the fourth crash");
		await run.close();
		await run.reopenState();
	},
};
