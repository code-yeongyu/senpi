#!/usr/bin/env node
/**
 * Scenario `resume`: a model-driven blocking question is left dangling by
 * SIGKILLing the host mid-question; re-opening the session path on a fresh
 * host must re-present the question exactly once when a question UI exists, or
 * deliver exactly one orphaned-after-restart user message when it does not.
 * Re-emitting NOTHING is a HARD failure.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { delay, messageText } from "./lib/rpc-socket-client.mjs";
import { killTree, makeSandbox, spawnSenpiHost, stopHost } from "./lib/rpc-host.mjs";
import { connect, isQuestionFrame, openSession, removeWithRetries, teardown } from "./lib/probe-support.mjs";

const QUESTIONS = [
	{
		header: "Database",
		question: "Which database should I use?",
		options: [
			{ label: "PostgreSQL", description: "Relational" },
			{ label: "SQLite", description: "Embedded" },
		],
		multiSelect: false,
	},
	{
		header: "Region",
		question: "Which region should it run in?",
		options: [
			{ label: "EU", description: "Frankfurt" },
			{ label: "US", description: "Virginia" },
		],
		multiSelect: false,
	},
];
const ORPHANED_TEXT = "The pending question could not be resumed after a restart";

export async function runResume(report) {
	const sandbox = makeSandbox("resume");
	report.info("sandbox", { dir: sandbox.dir, socketPath: sandbox.socketPath });
	let a;
	let a2;
	let sessionId;
	let sandboxRemoved = false;
	const host1 = await spawnSenpiHost({
		sandbox,
		turns: [{ toolCalls: [{ name: "ask_user_question", args: { waitForAnswer: true, questions: QUESTIONS } }] }],
		onLog: (line) => report.observe("host1", "host1", line),
	});
	try {
		a = await connect(sandbox.socketPath, "A", report);
		const opened = await openSession(a, { cwd: sandbox.work });
		sessionId = opened.data.sessionId;
		const sessionPath = opened.data.state.sessionFile;
		const markAsk = a.mark();
		await a.request({ type: "prompt", sessionId, message: "please ask me the questions" }, 60_000);
		const frame = await a.waitFor((message) => isQuestionFrame(message) && message.waitForAnswer === true, markAsk, 60_000);
		await a.waitFor((message) => message.type === "tool_execution_start" && message.toolName === "ask_user_question", markAsk);
		report.pass("model-driven-question-pending", {
			questions: frame.questions.map((question) => question.id),
			sessionPath,
		});

		a.close();
		killTree(host1.child.pid, "SIGKILL");
		await new Promise((resolve) => host1.child.once("exit", resolve));
		await host1.model.stop();
		if (existsSync(sandbox.socketPath)) unlinkSync(sandbox.socketPath);
		report.pass("host-sigkilled-mid-question", { socketCleared: !existsSync(sandbox.socketPath) });

		const host2 = await spawnSenpiHost({
			sandbox,
			turns: [{ text: "ok" }],
			onLog: (line) => report.observe("host2", "host2", line),
		});
		try {
			a2 = await connect(sandbox.socketPath, "A2", report);
			const markReopen = a2.mark();
			const reopened = await openSession(a2, { sessionPath, cwd: sandbox.work }, 30_000);
			report.pass("session-reopened", { sessionId: reopened.data.sessionId, attached: reopened.data.attached === true });
			const outcome = await raceResumeOutcome(a2, markReopen);
			if (outcome.kind === "question") {
				report.pass("dangling-question-re-presented", { id: outcome.frame.id });
				const rePresented = await a2.waitForStable(isQuestionFrame, markReopen, 1, 1_500);
				report.check("re-presented-questions-match", {
					expected: QUESTIONS.map((question) => question.header),
					actual: rePresented.questions.map((question) => question.header),
				});
				a2.write({
					type: "extension_ui_response",
					sessionId: reopened.data.sessionId,
					id: rePresented.id,
					answers: { q1: { selected: ["PostgreSQL"] } },
					comment: "resumed answer",
				});
				await a2.waitFor((message) => message.type === "question_resolved", markReopen);
				const framed = await a2.waitFor(
					(message) => message.type === "message_end" && message.message?.role === "user" && messageText(message.message).startsWith("[Answer to question "),
					markReopen,
					20_000,
				);
				report.check("resumed-answer-framed-once", {
					expected: { containsAnswer: true },
					actual: { containsAnswer: messageText(framed.message).includes("resumed answer") },
				});
				report.check("resumed-entry-count", { expected: 1, actual: countResumedEntries(sessionPath) });
			} else if (outcome.kind === "orphaned") {
				report.pass("dangling-question-orphaned-after-restart", { text: messageText(outcome.message.message) });
				report.check("orphaned-message-text", {
					expected: { containsOrphanedText: true },
					actual: { containsOrphanedText: messageText(outcome.message.message).includes(ORPHANED_TEXT) },
				});
				report.check("resumed-entry-count", { expected: 1, actual: countResumedEntries(sessionPath) });
			} else {
				report.fail("dangling-question-re-presented", {
					expected: "one re-presented extension_ui_request{method:question} or one orphaned-after-restart message",
					actual: "nothing re-emitted after open_session",
				});
				const state = await a2.request({ type: "get_state", sessionId: reopened.data.sessionId });
				report.info("reopened-state-pending", { pendingQuestions: state.data.pendingQuestions?.length ?? 0 });
				const messages = await a2.request({ type: "get_messages", sessionId: reopened.data.sessionId });
				const dangling = (messages.data?.messages ?? []).some(
					(message) =>
						message.role === "assistant" &&
						Array.isArray(message.content) &&
						message.content.some((part) => part?.type === "toolCall" && part.name === "ask_user_question"),
				);
				report.info("dangling-call-visible-after-restart", { dangling });
				report.info("resumed-entry-count", { count: countResumedEntries(sessionPath) });
			}
			return true;
		} finally {
			await teardown(report, { clients: [a2], host: host2, sandbox, label: "resume-host2" });
			sandboxRemoved = true;
		}
	} catch (error) {
		report.fail("scenario-error", { error: String(error?.stack ?? error) });
		const live = a2 && !a2.closed ? a2 : a && !a.closed ? a : undefined;
		if (live) {
			report.info("records-so-far", {
				client: live.label,
				types: live.messages.map((message) => `${message.type}${message.command ? `:${message.command}` : ""}`).slice(-40),
			});
			try {
				await live.request({ type: "get_protocol_info" }, 5_000);
				report.info("host-liveness", { responsive: true });
			} catch (probeError) {
				report.info("host-liveness", { error: String(probeError) });
			}
			if (sessionId) {
				try {
					const state = await live.request({ type: "get_state", sessionId }, 5_000);
					report.info("worker-liveness", { pendingQuestions: state.data?.pendingQuestions?.length ?? 0, streaming: state.data?.isStreaming });
				} catch (probeError) {
					report.info("worker-liveness", { error: String(probeError) });
				}
			}
		}
		return false;
	} finally {
		await stopHost(host1.child, { signal: "SIGKILL" }).catch(() => {});
		await host1.model.stop().catch(() => {});
		a?.close();
		if (!sandboxRemoved) {
			if (existsSync(sandbox.socketPath)) unlinkSync(sandbox.socketPath);
			const removed = await removeWithRetries(sandbox);
			report.pass("resume-host1-cleanup", {
				hostExited: host1.child.exitCode !== null || host1.child.signalCode !== null,
				socketRemoved: !existsSync(sandbox.socketPath),
				sandboxRemoved: removed,
				socketPath: sandbox.socketPath,
			});
		}
	}
}

async function raceResumeOutcome(client, mark) {
	const question = client
		.waitFor((message) => isQuestionFrame(message), mark, 12_000)
		.then((frame) => ({ kind: "question", frame }))
		.catch(() => undefined);
	const orphaned = client
		.waitFor(
			(message) =>
				message.type === "message_end" && message.message?.role === "user" && messageText(message.message).startsWith("[Answer to question "),
			mark,
			12_000,
		)
		.then((message) => ({ kind: "orphaned", message }))
		.catch(() => undefined);
	await delay(12_500);
	return (await question) ?? (await orphaned) ?? { kind: "nothing" };
}

function countResumedEntries(sessionPath) {
	try {
		return readFileSync(sessionPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "custom" && entry.customType === "ask-user:resumed").length;
	} catch {
		return -1;
	}
}
