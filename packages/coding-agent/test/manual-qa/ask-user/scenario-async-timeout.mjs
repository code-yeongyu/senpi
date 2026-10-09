#!/usr/bin/env node
/**
 * Scenario `async`: wait=false returns an accepted tool result immediately, the
 * answer arrives later as exactly ONE framed user message; with no answer the
 * 1-minute idle timeout resolves `timed_out` once - the broadcast outcome
 * included, not just the framed notice - and the notice is delivered once.
 */

import { makeSandbox, spawnSenpiHost } from "./lib/rpc-host.mjs";
import { connect, isQuestionFrame, openSession, readFixtureLog, teardown } from "./lib/probe-support.mjs";
import { messageText } from "./lib/rpc-socket-client.mjs";

const FRAMED = /^\[Answer to question /;
const TIMEOUT_MARKER = "(사용자가 답변을 안하고 timeout 으로 종료됨)";

export async function runAsyncTimeout(report) {
	const sandbox = makeSandbox("async");
	report.info("sandbox", { dir: sandbox.dir, socketPath: sandbox.socketPath, timeoutMinutes: 1 });
	const host = await spawnSenpiHost({
		sandbox,
		turns: [{ text: "ok" }, { text: "ok" }],
		timeoutMinutes: 1,
		onLog: (line) => report.observe("host", "host", line),
	});
	let a;
	try {
		a = await connect(sandbox.socketPath, "A", report);
		const opened = await openSession(a, { cwd: sandbox.work });
		const sessionId = opened.data.sessionId;

		const markAsk1 = a.mark();
		await a.request({ type: "prompt", sessionId, message: "/askq wait=false label=async1" });
		const frame1 = await a.waitFor(isQuestionFrame, markAsk1);
		report.check("async-frame", { expected: false, actual: frame1.waitForAnswer });
		await a.waitFor(
			(message) =>
				message.type === "extension_ui_request" &&
				message.method === "notify" &&
				String(message.message ?? "").includes("[askq async1] tool result received"),
			markAsk1,
		);
		const accepted = readFixtureLog(sandbox.fixtureLog)
			.filter((entry) => entry.event === "result")
			.at(-1);
		report.check("async-tool-result-immediate", {
			expected: { accepted: true, status: "pending", requestId: frame1.requestId },
			actual: {
				accepted: accepted?.details?.accepted === true,
				status: accepted?.details?.status,
				requestId: accepted?.details?.requestId,
			},
		});

		a.write({
			type: "extension_ui_response",
			sessionId,
			id: frame1.id,
			answers: { q1: { selected: ["SQLite"] } },
			comment: "embedded is fine",
		});
		const resolved = await a.waitFor((message) => message.type === "question_resolved" && message.id === frame1.id, markAsk1);
		report.check("async-resolved", {
			expected: { outcome: "comment-submitted", unanswered: ["q2"] },
			actual: { outcome: resolved.outcome, unanswered: resolved.unanswered },
		});
		const answerMessage = await a.waitFor(
			(message) => message.type === "message_end" && message.message?.role === "user" && FRAMED.test(messageText(message.message)),
			markAsk1,
		);
		report.check("answer-framed-once-text", {
			expected: {
				text: `[Answer to question ${accepted.details.requestId}]\nThe user responded: embedded is fine\nDatabase: SQLite\nUnanswered: Deploy`,
			},
			actual: { text: messageText(answerMessage.message) },
		});
		await a.waitFor((message) => message.type === "agent_settled", markAsk1);

		const markAsk2 = a.mark();
		await a.request({ type: "prompt", sessionId, message: "/askq wait=false label=async2 n=1" });
		const frame2 = await a.waitFor(isQuestionFrame, markAsk2);
		report.check("timeout-question-frame", { expected: { waitForAnswer: false, questionCount: 1, timeout: 60_000 }, actual: { waitForAnswer: frame2.waitForAnswer, questionCount: frame2.questions.length, timeout: frame2.timeout } });
		const timedOut = await a.waitFor(
			(message) => message.type === "question_resolved" && message.id === frame2.id,
			markAsk2,
			120_000,
		);
		report.check("timeout-resolution-outcome", {
			expected: { outcome: "timed_out", unanswered: ["q1"] },
			actual: { outcome: timedOut.outcome, unanswered: timedOut.unanswered },
		});
		const timeoutMessage = await a.waitFor(
			(message) =>
				message.type === "message_end" &&
				message.message?.role === "user" &&
				messageText(message.message).includes(TIMEOUT_MARKER),
			markAsk2,
			20_000,
		);
		report.check("timeout-notice-delivered", {
			expected: { containsMarker: true, mentionsMinutes: true },
			actual: {
				containsMarker: messageText(timeoutMessage.message).includes(TIMEOUT_MARKER),
				mentionsMinutes: messageText(timeoutMessage.message).includes("did not answer within 1 minutes"),
			},
		});

		const messages = await a.request({ type: "get_messages", sessionId });
		const framed = (messages.data?.messages ?? []).filter(
			(message) => message.role === "user" && FRAMED.test(messageText(message)),
		);
		report.check("framed-messages-exactly-two", {
			expected: {
				total: 2,
				withTimeoutMarker: 1,
				withAnswerText: 1,
			},
			actual: {
				total: framed.length,
				withTimeoutMarker: framed.filter((message) => messageText(message).includes(TIMEOUT_MARKER)).length,
				withAnswerText: framed.filter((message) => messageText(message).includes("embedded is fine")).length,
			},
		});
		return true;
	} catch (error) {
		report.fail("scenario-error", { error: String(error?.stack ?? error) });
		return false;
	} finally {
		await teardown(report, { clients: [a], host, sandbox, label: "async" });
	}
}
