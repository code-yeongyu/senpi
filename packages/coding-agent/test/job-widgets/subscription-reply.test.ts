/** senpi#4669: a new RPC subscriber gets the session's job widget state through its own reply, not a republish. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXTENSION_RPC_SUBSCRIBED_CHANNEL } from "../../src/core/event-bus.ts";
import jobWidgetsExtension from "../../src/core/extensions/builtin/job-widgets/extension.ts";
import {
	closeJobWidgetSession,
	getJobWidgetState,
	type JobWidgetAuthor,
	openJobWidgetSession,
	registerJobWidgetSource,
	TextTap,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

const sessionId = "subscription_reply";
const pendingAuthor: JobWidgetAuthor = (_request, signal) =>
	new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "skipped" })));

let dir = "";
beforeEach(() => {
	vi.useFakeTimers({ now: 1_000_000 });
	dir = mkdtempSync(join(tmpdir(), "job-widgets-reply-"));
});
afterEach(() => {
	closeJobWidgetSession(sessionId);
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

it("answers a new subscriber with the shown state and publishes nothing to the others", async () => {
	const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const subscribed: Array<(reply: unknown) => void> = [];
	const rpcEmit = vi.fn();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => lifecycle.set(event, handler),
		events: {
			on: (channel: string, listener: (reply: unknown) => void) => {
				if (channel === EXTENSION_RPC_SUBSCRIBED_CHANNEL) subscribed.push(listener);
				return () => {};
			},
			emit: () => {},
		},
		rpc: { emit: rpcEmit },
	} as unknown as ExtensionAPI;
	jobWidgetsExtension(pi);
	const ctx = {
		cwd: dir,
		agentDir: dir,
		mode: "rpc",
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId },
	};
	lifecycle.get("session_start")?.({}, ctx as unknown as ExtensionContext);
	closeJobWidgetSession(sessionId);
	openJobWidgetSession(sessionId, { authorAfterMs: 60_000, author: pendingAuthor, publish: () => {} });
	const tap = new TextTap("out", "command output");
	const handle = registerJobWidgetSource({
		sessionId,
		id: "bash_1",
		kind: "bash",
		sources: [tap],
		brief: { command: "deploy" },
		startedAtMs: Date.now(),
	});
	tap.append("step 1\nstep 2\nstep 3\n");
	handle?.notify();
	await vi.advanceTimersByTimeAsync(5_000);
	const published = vi.fn();
	openJobWidgetSession(sessionId, { authorAfterMs: 0, author: pendingAuthor, publish: published });
	await vi.advanceTimersByTimeAsync(1_000);
	const state = getJobWidgetState(sessionId);
	expect(state?.jobs).toHaveLength(1);
	published.mockClear();
	const reply = vi.fn();
	for (const listener of subscribed) listener(reply);
	expect(reply).toHaveBeenCalledExactlyOnceWith({ name: "job_widget_state", data: state });
	expect(published).not.toHaveBeenCalled();
	expect(rpcEmit).not.toHaveBeenCalled();
	handle?.dispose();
});
