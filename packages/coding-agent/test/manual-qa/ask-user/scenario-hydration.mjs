#!/usr/bin/env node
/**
 * Scenario `hydration`: two extra connections, hydration replay, progress
 * broadcast, partial answer with comment, late answer, state clearance.
 * (The plan's "kill A" step lives in `owner-drop`, which owns its defect.)
 */

import { makeSandbox, spawnSenpiHost } from "./lib/rpc-host.mjs";
import { connect, isQuestionFrame, openSession, readFixtureLog, teardown } from "./lib/probe-support.mjs";
import { messageText } from "./lib/rpc-socket-client.mjs";

const HOLD_MS = 1_500;

export async function runHydration(report) {
	const sandbox = makeSandbox("hydration");
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
		report.pass("open-session", { sessionId, sessionPath });

		const markAsk = a.mark();
		await a.request({ type: "prompt", sessionId, message: "/askq wait=true" });
		const frame = await a.waitFor(isQuestionFrame, markAsk);
		report.check("question-frame-on-requester", {
			expected: { waitForAnswer: true, questionCount: 2, timeout: 1_800_000 },
			actual: { waitForAnswer: frame.waitForAnswer, questionCount: frame.questions.length, timeout: frame.timeout },
		});

		b = await connect(sandbox.socketPath, "B", report);
		const markB = b.mark();
		const openB = await openSession(b, { sessionPath, cwd: sandbox.work });
		report.check("hydration-state", {
			expected: { attached: true, pendingQuestions: 1 },
			actual: {
				attached: openB.data.attached === true,
				pendingQuestions: openB.data.state.pendingQuestions?.length ?? 0,
			},
		});
		const replayedB = await b.waitForStable(isQuestionFrame, markB, 1, HOLD_MS);
		report.pass("replayed-exactly-once-B", {
			id: replayedB.id,
			questions: replayedB.questions.map((question) => question.id),
		});

		c = await connect(sandbox.socketPath, "C", report);
		const markC = c.mark();
		await openSession(c, { sessionPath, cwd: sandbox.work });
		const replayedC = await c.waitForStable(isQuestionFrame, markC, 1, HOLD_MS);
		report.check("replayed-id-stable", { expected: frame.id, actual: replayedC.id });

		c.write({
			type: "extension_ui_progress",
			sessionId,
			id: frame.id,
			answers: { q1: { selected: ["PostgreSQL"] } },
			comment: "drafting",
		});
		const [updatedB, updatedC] = await Promise.all([
			b.waitFor((message) => message.type === "question_updated" && message.id === frame.id, markB),
			c.waitFor((message) => message.type === "question_updated" && message.id === frame.id, markC),
		]);
		report.check("progress-broadcast", {
			expected: { deadlineExtended: true, remainingPositive: true },
			actual: {
				deadlineExtended: updatedB.deadlineAtMs > frame.deadlineAtMs,
				remainingPositive: updatedC.remainingMs > 0,
			},
		});

		const markResolveA = a.mark();
		const markResolveB = b.mark();
		const markResolveC = c.mark();
		c.write({
			type: "extension_ui_response",
			sessionId,
			id: frame.id,
			answers: { q1: { selected: ["PostgreSQL"] } },
			comment: "take the managed one",
		});
		const [resolvedA, resolvedB, resolvedC] = await Promise.all([
			a.waitFor((message) => message.type === "question_resolved" && message.id === frame.id, markResolveA),
			b.waitFor((message) => message.type === "question_resolved" && message.id === frame.id, markResolveB),
			c.waitFor((message) => message.type === "question_resolved" && message.id === frame.id, markResolveC),
		]);
		report.check("resolved-broadcast-all-connections", {
			expected: { outcome: "comment-submitted", unanswered: ["q2"], selected: ["PostgreSQL"], peers: 3 },
			actual: {
				outcome: resolvedB.outcome,
				unanswered: resolvedB.unanswered,
				selected: resolvedB.answers.q1?.selected,
				peers: new Set([resolvedA, resolvedB, resolvedC].map((record) => record.id)).size === 1 ? 3 : 0,
			},
		});

		await a.waitFor(
			(message) =>
				message.type === "extension_ui_request" &&
				message.method === "notify" &&
				String(message.message ?? "").includes("[askq askq] tool result received"),
			markResolveA,
		);
		const result = readFixtureLog(sandbox.fixtureLog)
			.filter((entry) => entry.event === "result")
			.at(-1);
		report.check("tool-result-carries-answer", {
			expected: {
				responded: true,
				selected: true,
				unansweredListed: true,
				status: "comment-submitted",
			},
			actual: {
				responded: Boolean(result?.text?.includes("The user responded: take the managed one")),
				selected: Boolean(result?.text?.includes("Database: PostgreSQL")),
				unansweredListed: Boolean(result?.text?.includes("Unanswered: Deploy")),
				status: result?.details?.status,
			},
		});

		const markLate = c.mark();
		c.write({ type: "extension_ui_response", sessionId, id: frame.id, answers: { q1: { selected: ["SQLite"] } }, comment: "late" });
		const late = await c.waitFor(
			(message) => message.type === "response" && message.command === "extension_ui_response" && message.id === frame.id,
			markLate,
		);
		report.check("late-answer-typed-error", {
			expected: { success: false, error: "question_already_resolved" },
			actual: { success: late.success, error: late.error },
		});

		const state = await a.request({ type: "get_state", sessionId });
		report.check("state-pending-cleared", {
			expected: 0,
			actual: state.data.pendingQuestions?.length ?? 0,
		});
		report.check("blocking-mode-no-framed-message", {
			expected: 0,
			actual: await countUserMessages(a, sessionId),
		});
		return true;
	} catch (error) {
		report.fail("scenario-error", { error: String(error?.stack ?? error) });
		return false;
	} finally {
		await teardown(report, { clients: [a, b, c], host, sandbox, label: "hydration" });
	}
}

async function countUserMessages(client, sessionId) {
	const messages = await client.request({ type: "get_messages", sessionId });
	return (messages.data?.messages ?? []).filter(
		(message) => message.role === "user" && messageText(message).startsWith("[Answer to question "),
	).length;
}
