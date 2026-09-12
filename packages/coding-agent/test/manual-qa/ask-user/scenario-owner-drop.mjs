#!/usr/bin/env node
/**
 * Scenario `owner-drop`: the connection that OPENED the session is killed
 * while a blocking question is pending and other connections are attached.
 * Spec: the question is session-owned and must survive (docs/rpc.md: pending
 * questions are broadcast to all attached connections and survive the message),
 * and a surviving connection can still answer it. Every criterion is a HARD
 * assertion: pending UI requests may only be cancelled by an actual teardown.
 */

import { makeSandbox, spawnSenpiHost } from "./lib/rpc-host.mjs";
import { connect, isQuestionFrame, openSession, readFixtureLog, teardown } from "./lib/probe-support.mjs";
import { delay } from "./lib/rpc-socket-client.mjs";

export async function runOwnerDrop(report) {
	const sandbox = makeSandbox("owner-drop");
	report.info("sandbox", { dir: sandbox.dir, socketPath: sandbox.socketPath });
	const host = await spawnSenpiHost({ sandbox, onLog: (line) => report.observe("host", "host", line) });
	let a;
	let b;
	let c;
	try {
		a = await connect(sandbox.socketPath, "A", report);
		const opened = await openSession(a, { cwd: sandbox.work });
		const sessionId = opened.data.sessionId;
		const sessionPath = opened.data.state.sessionFile;
		const markAsk = a.mark();
		await a.request({ type: "prompt", sessionId, message: "/askq wait=true label=drop1" });
		const frame = await a.waitFor(isQuestionFrame, markAsk);

		b = await connect(sandbox.socketPath, "B", report);
		const markB = b.mark();
		await openSession(b, { sessionPath, cwd: sandbox.work });
		await b.waitForStable(isQuestionFrame, markB, 1, 1_000);
		report.pass("question-live-with-two-connections", { id: frame.id });

		const markDrop = b.mark();
		a.close();
		await delay(2_000);
		const cancelled = b.find(markDrop, (message) => message.type === "question_resolved" && message.id === frame.id);
		if (cancelled) report.info("owner-drop-resolution", { outcome: cancelled.outcome });
		report.check("question-survives-owner-drop", {
			expected: { resolvedBroadcasts: 0 },
			actual: { resolvedBroadcasts: cancelled ? 1 : 0 },
		});

		c = await connect(sandbox.socketPath, "C", report);
		const openC = await openSession(c, { sessionPath, cwd: sandbox.work });
		report.check("pending-question-hydrates-for-C", {
			expected: 1,
			actual: openC.data.state.pendingQuestions?.length ?? 0,
		});

		const markAnswer = c.mark();
		c.write({
			type: "extension_ui_response",
			sessionId,
			id: frame.id,
			answers: { q1: { selected: ["PostgreSQL"] } },
			comment: "answered after the drop",
		});
		const answered = await Promise.race([
			c.waitFor((message) => message.type === "question_resolved" && message.id === frame.id, markAnswer),
			delay(5_000).then(() => undefined),
		]);
		report.check("C-can-answer-after-drop", {
			expected: { resolved: true, outcome: "comment-submitted", unanswered: ["q2"] },
			actual: { resolved: answered !== undefined, outcome: answered?.outcome, unanswered: answered?.unanswered },
		});
		if (!answered) {
			const rejected = c.find(
				markAnswer,
				(message) => message.type === "response" && message.command === "extension_ui_response" && message.id === frame.id,
			);
			report.info("late-answer-rejection", { error: rejected?.error });
		}

		await delay(1_000);
		const result = readFixtureLog(sandbox.fixtureLog)
			.filter((entry) => entry.event === "result" && entry.label === "drop1")
			.at(-1);
		report.check("fixture-result-after-drop", {
			expected: { status: "comment-submitted", textPreview: "The user responded: answered after the drop" },
			actual: { status: result?.details?.status, textPreview: result?.text?.split("\n")[0] },
		});
		return true;
	} catch (error) {
		report.fail("scenario-error", { error: String(error?.stack ?? error) });
		return false;
	} finally {
		await teardown(report, { clients: [a, b, c], host, sandbox, label: "owner-drop" });
	}
}
