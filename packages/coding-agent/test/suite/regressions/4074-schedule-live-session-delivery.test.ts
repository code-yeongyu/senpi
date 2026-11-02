/**
 * senpi#4074: a durable `schedule_prompt` job that comes due while its session is open is delivered into
 * that live session: steered into a running turn, or starting a turn when idle. Runs through
 * `createHarness` with the real schedule extension and the real session queue; only the clock and the
 * timer are injected.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { runDueJobs } from "../../../src/cli/schedule-runner.ts";
import { createScheduleExtension } from "../../../src/core/extensions/builtin/schedule/index.ts";
import type { LiveTimerPort } from "../../../src/core/extensions/builtin/schedule/live-delivery.ts";
import { SCHEDULE_PROMPT_TOOL } from "../../../src/core/extensions/builtin/schedule/tool.ts";
import { emitSessionShutdownEvent } from "../../../src/core/extensions/runner.ts";
import { claimOccurrence } from "../../../src/core/extensions/builtin/schedule/occurrences.ts";
import { ownRunnerIdentity } from "../../../src/core/extensions/builtin/schedule/runner-lease.ts";
import {
	createScheduledJob,
	listScheduledJobs,
	scheduleDir,
} from "../../../src/core/extensions/builtin/schedule/store.ts";
import { createHarness, createTestUiContext, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const T0 = Date.parse("2026-10-23T08:00:00Z");
const MARKER = "scheduled-check-4074";

class FakeTimer implements LiveTimerPort {
	fire: (() => Promise<void>) | undefined;
	delayMs: number | undefined;
	arm(delayMs: number, fire: () => Promise<void>): void {
		this.delayMs = delayMs;
		this.fire = fire;
	}
	cancel(): void {
		this.fire = undefined;
		this.delayMs = undefined;
	}
	async fireNow(): Promise<void> {
		const fire = this.fire;
		if (fire === undefined) throw new Error("no pass armed");
		this.fire = undefined;
		await fire();
	}
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function waitTool(): { tool: AgentTool; release: () => void; started: Promise<void> } {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started: () => void = () => {};
	const startedPromise = new Promise<void>((resolve) => {
		started = resolve;
	});
	return {
		release,
		started: startedPromise,
		tool: {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				started();
				await released;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		},
	};
}

async function openSession(tools: AgentTool[]) {
	let now = T0;
	let onNow: (() => void) | undefined;
	const timer = new FakeTimer();
	const harness = await createHarness({
		tools,
		persistSession: true,
		extensionFactories: [
			createScheduleExtension({
				now: () => {
					onNow?.();
					return now;
				},
				timer: () => timer,
			}),
		],
	});
	harnesses.push(harness);
	const dir = scheduleDir(join(harness.tempDir, "agent"));
	await createScheduledJob(
		dir,
		{
			sessionId: harness.sessionManager.getSessionId(),
			sessionFile: harness.sessionManager.getSessionFile() ?? null,
			cwd: harness.tempDir,
			prompt: MARKER,
			dueAt: T0 + 60_000,
			everyMs: null,
		},
		T0,
	);
	const warnings: string[] = [];
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({ notify: (message) => warnings.push(message) }),
	});
	return {
		harness,
		timer,
		dir,
		warnings,
		advance: (ms: number) => {
			now += ms;
		},
		/** Runs on every clock read the extension makes, so a test can act at an exact point inside a pass. */
		setOnNow: (hook: (() => void) | undefined) => {
			onNow = hook;
		},
	};
}

describe("schedule_prompt jobs reach the open session (#4074)", () => {
	it("steers a job that comes due mid-turn into the running turn", async () => {
		const wait = waitTool();
		const live = await openSession([wait.tool]);
		expect(live.timer.delayMs).toBe(60_000);

		live.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn reply"),
			fauxAssistantMessage("extra reply"),
		]);
		const userTurn = live.harness.session.prompt("user question");
		await wait.started;

		live.advance(60_000);
		await live.timer.fireNow();
		expect(live.harness.session.getSteeringMessages().some((text) => text.includes(MARKER))).toBe(true);

		wait.release();
		await userTurn;
		await live.harness.session.waitForIdle();
		const messages = live.harness.session.messages;
		const next = messages[messages.findIndex((message) => message.role === "toolResult") + 1];
		expect(next?.role).toBe("user");
		expect(next === undefined ? "" : getMessageText(next)).toContain(MARKER);
		const left = await listScheduledJobs(live.dir);
		expect(left.jobs).toHaveLength(0);
	});

	it("starts a turn with a job that comes due while the session is idle", async () => {
		const live = await openSession([]);
		live.harness.setResponses([fauxAssistantMessage("handled")]);

		live.advance(60_000);
		await live.timer.fireNow();
		await live.harness.session.waitForIdle();

		expect(getUserTexts(live.harness).some((text) => text.includes(MARKER))).toBe(true);
	});

	it("keeps an outside runner from abandoning an occurrence the live session is delivering", async () => {
		const live = await openSession([]);
		const listing = await listScheduledJobs(live.dir);
		const job = listing.jobs[0]?.job;
		if (job === undefined) throw new Error("job missing");
		const claimed = await claimOccurrence(live.dir, job, ownRunnerIdentity());
		expect(claimed).toBeDefined();

		const outside = await runDueJobs({
			dir: live.dir,
			now: () => T0 + 120_000,
			deliver: async () => ({ ok: true }),
			owner: { pid: process.pid + 100_000, processStartedAtMs: 1 },
		});

		expect(outside.events.filter((event) => event.event === "abandoned")).toEqual([]);
	});
	it("tells the user when a due job cannot be delivered", async () => {
		const live = await openSession([]);
		// A file where the session-lock directory belongs makes this job's delivery fail inside the pass.
		writeFileSync(join(live.dir, "sessions"), "");

		live.advance(60_000);
		await live.timer.fireNow();

		expect(live.warnings.some((warning) => warning.includes("could not be delivered"))).toBe(true);
	});

	it("finishes the pass in flight before shutdown releases the runner lease", async () => {
		const live = await openSession([]);
		live.harness.setResponses([fauxAssistantMessage("handled")]);
		const firing = join(live.dir, "firing");
		let shutdown: Promise<unknown> | undefined;
		let shutdownStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			shutdownStarted = resolve;
		});
		// The clock read right after the claim: the occurrence is in firing/ and not yet settled.
		live.setOnNow(() => {
			if (shutdown !== undefined || !existsSync(firing) || readdirSync(firing).length === 0) return;
			shutdown = emitSessionShutdownEvent(live.harness.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
			shutdownStarted();
		});

		live.advance(60_000);
		const pass = live.timer.fireNow();
		await started;
		await shutdown;

		// The lease is released only after the claim settled, so no outside runner can find it abandoned.
		expect(readdirSync(firing)).toEqual([]);
		await pass;
		await live.harness.session.waitForIdle();
	});

	it("does not tell a live session that its job waits for a runner", async () => {
		const live = await openSession([]);
		live.harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall(SCHEDULE_PROMPT_TOOL, { action: "create", prompt: "later", delaySeconds: 300 })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("ok"),
		]);
		await live.harness.session.prompt("schedule it");

		const result = live.harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === SCHEDULE_PROMPT_TOOL,
		);
		const text = result === undefined ? "" : getMessageText(result);
		expect(text).toContain("delivers the prompt itself");
		expect(text).not.toContain("the job fires the next time a runner runs");
	});
});
