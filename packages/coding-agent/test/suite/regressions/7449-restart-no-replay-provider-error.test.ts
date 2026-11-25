/**
 * senpi#7449: an RPC host stopped itself on idle, and the next host start re-ran every session whose last
 * engine-started run was unfinished: 31 sessions whose turns had ended on their own with a provider 429 each sent
 * another request into the same limit within ~2 s. A run whose newest model response ended in a provider error was
 * not cut by the restart, so the restart must not continue it: the session stays held, naming why, until a person
 * (or the goal) resumes it. A run the restart genuinely cut still continues (senpi#7020, senpi#7079).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import {
	answer,
	cleanupKilledMidRun,
	engineStarted,
	killedMidRun,
	reopenContinued,
} from "./7020-killed-mid-run-support.ts";
import { within } from "./7020-live-park-support.ts";

afterEach(cleanupKilledMidRun);

const TURN_MS = 10_000;

const rateLimited: AssistantMessage = {
	...answer(""),
	content: [],
	stopReason: "error",
	errorMessage:
		'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
};
const toolStep = (saved: SessionManager): void => {
	saved.appendMessage({
		...answer(""),
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } }],
		stopReason: "toolUse",
	});
	saved.appendMessage({
		role: "toolResult",
		toolCallId: "read-1",
		toolName: "read",
		content: [{ type: "text", text: "notes" }],
		isError: false,
		timestamp: 2,
	});
};

it.each([
	["its first request", (saved: SessionManager) => saved.appendMessage(rateLimited)],
	[
		"a request after a completed tool step",
		(saved: SessionManager) => {
			toolStep(saved);
			saved.appendMessage(rateLimited);
		},
	],
])("leaves an engine-started run that ended on a provider 429 at %s held, sending nothing", async (_, ended) => {
	const { base, file } = await killedMidRun(
		(saved) => {
			engineStarted(saved);
			ended(saved);
		},
		{ cutTool: false },
	);
	const { h } = await reopenContinued(base, file);
	await h.session.waitForIdle();
	// The restart decides while the reopen binds: a released hold is the resume, so a kept one means no turn can start.
	expect(h.session.holds.map(({ key, data }) => ({ key, data }))).toEqual([
		{ key: "interrupted-run", data: { reason: "ended_on_provider_error" } },
	]);
	expect(h.faux.state.callCount).toBe(0);
});

it.each([
	[
		"aborted by the host's shutdown",
		(saved: SessionManager) => saved.appendMessage({ ...answer(""), content: [], stopReason: "aborted" }),
	],
	[
		"cut mid-tool after a 429 that a retry already answered",
		(saved: SessionManager) => {
			saved.appendMessage(rateLimited);
			toolStep(saved);
		},
	],
])("still continues an engine-started run the restart cut: %s", async (_, cut) => {
	const { base, file } = await killedMidRun((saved) => {
		engineStarted(saved);
		cut(saved);
	});
	const { h, turn } = await reopenContinued(base, file);
	await within(turn, TURN_MS, "the continued run's turn");
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.holds).toEqual([]);
});
