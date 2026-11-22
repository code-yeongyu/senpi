import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import {
	createScheduledJob,
	listScheduledJobs,
	scheduleDir,
} from "../../src/core/extensions/builtin/schedule/store.ts";
import { SCHEDULE_PROMPT_TOOL, type SchedulePromptDetails } from "../../src/core/extensions/builtin/schedule/tool.ts";
import { MAX_PENDING_JOBS_PER_SESSION, MAX_PROMPT_BYTES } from "../../src/core/extensions/builtin/schedule/types.ts";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const SCHEDULE_EXTENSION_PATH = fileURLToPath(
	new URL("../../src/core/extensions/builtin/schedule/index.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** The harness session's agent directory, which the tool resolves through `ctx.agentDir`. */
function jobsDir(harness: Harness): string {
	return scheduleDir(join(harness.tempDir, "agent"));
}

async function scheduleHarness(): Promise<Harness> {
	const extensionsResult = await discoverAndLoadExtensions([SCHEDULE_EXTENSION_PATH], REPO_ROOT, REPO_ROOT);
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
	harnesses.push(harness);
	return harness;
}

async function callSchedule(harness: Harness, params: Record<string, unknown>) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(SCHEDULE_PROMPT_TOOL, params as JsonObject)], { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);
	await harness.session.prompt("go");
	const results = harness.session.messages.filter(
		(message) => message.role === "toolResult" && message.toolName === SCHEDULE_PROMPT_TOOL,
	);
	const result = results[results.length - 1];
	if (result?.role !== "toolResult") throw new Error("expected a schedule_prompt result");
	return result;
}

describe("schedule extension", () => {
	it("is registered as a builtin so every run mode, including --print, can schedule", () => {
		expect(builtinExtensions.map((extension) => extension.id)).toContain("schedule");
	});

	it("persists a job for the calling session that outlives the tool call", async () => {
		const harness = await scheduleHarness();
		const before = Date.now();

		const result = await callSchedule(harness, {
			action: "create",
			prompt: "tell Howard the build finished",
			delaySeconds: 300,
		});

		expect(result.isError).toBe(false);
		const details = result.details as unknown as SchedulePromptDetails;
		const { jobs } = await listScheduledJobs(jobsDir(harness));
		expect(jobs.map(({ state, job }) => ({ state, job }))).toEqual(details.jobs);
		expect(jobs).toHaveLength(1);
		const job = jobs[0]?.job;
		expect(job).toMatchObject({
			sessionId: harness.sessionManager.getSessionId(),
			prompt: "tell Howard the build finished",
			everyMs: null,
		});
		expect(job?.dueAt).toBeGreaterThanOrEqual(before + 300_000);
		expect(details.runnerAvailable).toBe(false);
	});

	it("lists and cancels only this session's jobs", async () => {
		const harness = await scheduleHarness();
		const dir = jobsDir(harness);
		const foreign = await createScheduledJob(
			dir,
			{
				sessionId: "other-session",
				sessionFile: null,
				cwd: "/",
				prompt: "not yours",
				dueAt: Date.now() + 60_000,
				everyMs: null,
			},
			Date.now(),
		);
		const created = await callSchedule(harness, {
			action: "create",
			prompt: "mine",
			at: new Date(Date.now() + 3_600_000).toISOString(),
			everySeconds: 86_400,
		});
		const ownId = (created.details as unknown as SchedulePromptDetails).jobs[0]?.job.id;

		const listed = await callSchedule(harness, { action: "list" });
		expect((listed.details as unknown as SchedulePromptDetails).jobs.map(({ job }) => job.id)).toEqual([ownId]);

		const refused = await callSchedule(harness, { action: "cancel", id: foreign.id });
		expect(refused.isError).toBe(true);
		const cancelled = await callSchedule(harness, { action: "cancel", id: ownId });
		expect(cancelled.isError).toBe(false);
		expect((await listScheduledJobs(dir)).jobs.map(({ job }) => job.id)).toEqual([foreign.id]);
	});

	it("rejects ambiguous, zone-less, past, too-frequent and oversized requests without writing a job", async () => {
		const harness = await scheduleHarness();

		const rejected = [
			await callSchedule(harness, { action: "create", prompt: "x", delaySeconds: 60, at: "2030-01-01T00:00:00Z" }),
			await callSchedule(harness, { action: "create", prompt: "x", at: "2030-01-01T09:00:00" }),
			await callSchedule(harness, { action: "create", prompt: "x", at: "2020-01-01T00:00:00Z" }),
			await callSchedule(harness, { action: "create", prompt: "x", delaySeconds: 60, everySeconds: 5 }),
			await callSchedule(harness, {
				action: "create",
				prompt: "x",
				delaySeconds: 60,
				everySeconds: 9_000_000_000_000,
			}),
			await callSchedule(harness, { action: "create", prompt: "x".repeat(MAX_PROMPT_BYTES + 1), delaySeconds: 60 }),
		];

		expect(rejected.map((result) => result.isError)).toEqual([true, true, true, true, true, true]);
		expect((await listScheduledJobs(jobsDir(harness))).jobs).toEqual([]);
	});

	it("accepts an explicit UTC offset and stops at the per-session capacity", async () => {
		const harness = await scheduleHarness();
		const dir = jobsDir(harness);
		const sessionId = harness.sessionManager.getSessionId();
		for (let index = 0; index < MAX_PENDING_JOBS_PER_SESSION - 1; index += 1) {
			await createScheduledJob(
				dir,
				{
					sessionId,
					sessionFile: null,
					cwd: "/",
					prompt: `job ${index}`,
					dueAt: Date.now() + 3_600_000,
					everyMs: null,
				},
				Date.now(),
			);
		}

		const tomorrow = Math.floor((Date.now() + 86_400_000) / 1000) * 1000;
		const inSeoul = new Date(tomorrow + 9 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+09:00");
		const last = await callSchedule(harness, { action: "create", prompt: "last", at: inSeoul });
		const overflow = await callSchedule(harness, { action: "create", prompt: "one too many", delaySeconds: 60 });

		expect(last.isError).toBe(false);
		expect((last.details as unknown as SchedulePromptDetails).jobs[0]?.job.dueAt).toBe(tomorrow);
		expect(overflow.isError).toBe(true);
		expect((await listScheduledJobs(dir)).jobs).toHaveLength(MAX_PENDING_JOBS_PER_SESSION);
	});
});
