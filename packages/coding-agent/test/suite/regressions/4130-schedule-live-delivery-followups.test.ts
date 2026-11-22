/**
 * senpi#4130 (follow-ups of #4074): a durable `schedule_prompt` job that comes due while its session is open is delivered into
 * that live session: steered into a running turn, or starting a turn when idle. Runs through
 * `createHarness` with the real schedule extension and the real session queue; only the clock and the
 * timer are injected.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runScheduleCommand } from "../../../src/cli/schedule-command.ts";
import { runDueJobs } from "../../../src/core/extensions/builtin/schedule/runner.ts";
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
	arms = 0;
	arm(delayMs: number, fire: () => Promise<void>): void {
		this.arms += 1;
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

/** Stands in for the `pending/` watch: a test fires its change events itself, all at once. */
class FakeWatch {
	onChange: (() => void) | undefined;
	readonly port = (_dir: string, onChange: () => void) => {
		this.onChange = onChange;
		return { close: () => {} };
	};
	emit(): void {
		this.onChange?.();
	}
}

async function openSession(tools: AgentTool[]) {
	let now = T0;
	const watch = new FakeWatch();
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
				watch: watch.port,
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
		watch,
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

describe("live delivery follow-ups (#4130)", () => {
	it("#given several changes in pending/ at once #when the watch reports them #then they run as one queued pass, not one pass each", async () => {
		const live = await openSession([]);
		expect(live.timer.arms).toBe(1);

		for (let change = 0; change < 5; change += 1) live.watch.emit();
		// A timer-fired pass queues behind every pass the changes started, so awaiting it settles them all.
		await live.timer.fireNow();

		expect(live.timer.arms).toBe(3);
	});

	it("#given a job whose delivery keeps failing #when its retries fail again #then the user is told once, not on every retry", async () => {
		const live = await openSession([]);
		// A file where the session-lock directory belongs makes every delivery of this job fail inside the pass.
		writeFileSync(join(live.dir, "sessions"), "");

		live.advance(60_000);
		await live.timer.fireNow();
		live.advance(live.timer.delayMs ?? 0);
		await live.timer.fireNow();
		live.advance(live.timer.delayMs ?? 0);
		await live.timer.fireNow();

		expect(live.warnings.filter((warning) => warning.includes("could not be delivered"))).toHaveLength(1);
	});

	it("#given a session that delivers its own jobs #when schedule list --json runs past the runner heartbeat window #then that holder is listed as a session, not as a stale runner", async () => {
		const live = await openSession([]);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join(live.harness.tempDir, "agent"));
		const written: string[] = [];
		const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		try {
			expect(await runScheduleCommand(["list", "--json"])).toBe(0);
		} finally {
			write.mockRestore();
			vi.unstubAllEnvs();
		}
		// The live session's lease beat at T0, years before this run's clock: a runner would read as stale here.
		const listing = JSON.parse(written.join("")) as { runners: { pid: number; holder?: string; fresh: boolean }[] };
		expect(listing.runners).toEqual([expect.objectContaining({ pid: process.pid, holder: "session", fresh: true })]);
	});
});
