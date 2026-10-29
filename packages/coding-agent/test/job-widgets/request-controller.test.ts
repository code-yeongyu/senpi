import { describe, expect, it } from "vitest";

import type { JobWidgetAuthor } from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { controllerFor, FakeJob, RPS_LINES, RPS_SPEC, scriptedAuthor, UNMATCHED_SPEC } from "./author-support.ts";
import { START, validSpec } from "./support.ts";

describe("job widget request controller: when a request starts", () => {
	it("waits until the job is 15 s old and one source has 3 lines", async () => {
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const { controller, advance } = controllerFor(author);
		advance(-1);
		expect(controller.maybeRequest(new FakeJob("young"))).toBeUndefined();
		advance(1);
		expect(controller.maybeRequest(new FakeJob("quiet", undefined, RPS_LINES.slice(0, 2)))).toBeUndefined();
		const outcome = await controller.maybeRequest(new FakeJob("ready"));
		expect(outcome).toMatchObject({ kind: "installed", spec: { title: "load test" } });
		expect(requests.map((request) => request.jobId)).toEqual(["ready"]);
	});

	it("never asks for a task job until its subagent names what to watch", async () => {
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const { controller } = controllerFor(author);
		const job = new FakeJob("st_1", { kind: "task", task: "tune the server" });
		expect(controller.maybeRequest(job)).toBeUndefined();
		job.brief = { ...job.brief, watch: "rps" };
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		expect(requests).toHaveLength(1);
	});
});

describe("job widget request controller: answers", () => {
	it("retries once with the validation errors and installs the fixed spec", async () => {
		const { author, requests } = scriptedAuthor(UNMATCHED_SPEC, RPS_SPEC);
		const { controller } = controllerFor(author);
		expect(await controller.maybeRequest(new FakeJob("bg_1"))).toMatchObject({ kind: "installed" });
		expect(requests).toHaveLength(2);
		expect(requests[0]?.rejected).toBeUndefined();
		expect(requests[1]?.rejected?.answer).toBe(JSON.stringify(UNMATCHED_SPEC));
		expect(requests[1]?.rejected?.errors).toContain(
			"no rule matches any sample line; copy the exact text of lines that carry the numbers",
		);
	});

	it("falls back after a second invalid answer and stops asking", async () => {
		const { author, requests } = scriptedAuthor(UNMATCHED_SPEC, UNMATCHED_SPEC, RPS_SPEC);
		const { controller, advance } = controllerFor(author);
		const job = new FakeJob("bg_1");
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "rejected" });
		advance(60_000);
		expect(controller.maybeRequest(job)).toBeUndefined();
		expect(requests).toHaveLength(2);
	});

	it("never asks a bash job again after it declines", async () => {
		const { author, requests } = scriptedAuthor({ skip: "no quantity" }, RPS_SPEC);
		const { controller, advance } = controllerFor(author);
		const job = new FakeJob("bg_1");
		expect(await controller.maybeRequest(job)).toEqual({ kind: "skipped", reason: "no quantity" });
		advance(3_600_000);
		expect(controller.maybeRequest(job)).toBeUndefined();
		expect(requests).toHaveLength(1);
	});

	it("asks a declined task job again only once its watch hint changes", async () => {
		const { author, requests } = scriptedAuthor({ skip: "nothing to chart" }, RPS_SPEC);
		const { controller } = controllerFor(author);
		const job = new FakeJob("st_1", { kind: "task", watch: "loss" });
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "skipped" });
		expect(controller.maybeRequest(job)).toBeUndefined();
		job.brief = { ...job.brief, watch: "rps" };
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		expect(requests).toHaveLength(2);
	});

	it("stops asking once the author has no model", async () => {
		const { author, requests } = scriptedAuthor(undefined, RPS_SPEC);
		const { controller } = controllerFor(author);
		const job = new FakeJob("bg_1");
		expect(await controller.maybeRequest(job)).toEqual({ kind: "unavailable" });
		expect(controller.maybeRequest(job)).toBeUndefined();
		expect(requests).toHaveLength(1);
	});
});

describe("job widget request controller: drift", () => {
	it("re-authors after 200 unmatched lines once the newest match is over 90 s old", async () => {
		const { author, requests } = scriptedAuthor(RPS_SPEC);
		const { controller, now } = controllerFor(author);
		const job = new FakeJob("bg_1");
		job.spec = validSpec(RPS_SPEC);
		job.unmatchedLines = 199;
		job.lastMatchAt = START - 100_000;
		expect(controller.maybeRequest(job)).toBeUndefined();
		job.unmatchedLines = 200;
		job.lastMatchAt = now - 90_000;
		expect(controller.maybeRequest(job)).toBeUndefined();
		job.lastMatchAt = now - 90_001;
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		expect(requests[0]?.previous).toEqual({ spec: job.spec, reason: "no rule matched the last 200 lines" });
	});
});

describe("job widget request controller: caps", () => {
	it("sends at most 3 requests per job, retries included", async () => {
		const { author, requests } = scriptedAuthor(RPS_SPEC, UNMATCHED_SPEC, UNMATCHED_SPEC, RPS_SPEC);
		const { controller } = controllerFor(author);
		const job = new FakeJob("bg_1");
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "installed" });
		job.spec = validSpec(RPS_SPEC);
		job.unmatchedLines = 500;
		expect(await controller.maybeRequest(job)).toMatchObject({ kind: "rejected" });
		expect(controller.maybeRequest(job)).toBeUndefined();
		expect(requests).toHaveLength(3);
	});

	it("leaves out the retry when the job has no request left", async () => {
		const { author, requests } = scriptedAuthor(UNMATCHED_SPEC);
		const { controller } = controllerFor(author, { maxRequestsPerJob: 1 });
		expect(await controller.maybeRequest(new FakeJob("bg_1"))).toMatchObject({ kind: "rejected" });
		expect(requests).toHaveLength(1);
	});

	it("keeps at most 2 requests in flight per session", async () => {
		const pending: PromiseWithResolvers<unknown>[] = [];
		const author: JobWidgetAuthor = () => {
			const deferred = Promise.withResolvers<unknown>();
			pending.push(deferred);
			return deferred.promise;
		};
		const { controller } = controllerFor(author);
		const first = controller.maybeRequest(new FakeJob("a"));
		expect(controller.maybeRequest(new FakeJob("b"))).toBeDefined();
		expect(controller.maybeRequest(new FakeJob("c"))).toBeUndefined();
		expect(controller.inFlight).toBe(2);
		pending[0]?.resolve(RPS_SPEC);
		expect(await first).toMatchObject({ kind: "installed" });
		expect(controller.maybeRequest(new FakeJob("c"))).toBeDefined();
		expect(pending).toHaveLength(3);
	});

	it("sends at most 30 requests per session in an hour", async () => {
		const { author, requests } = scriptedAuthor(...Array.from({ length: 31 }, () => ({ skip: "none" })));
		const { controller, advance } = controllerFor(author);
		for (let index = 0; index < 30; index++) {
			expect(await controller.maybeRequest(new FakeJob(`bg_${index}`))).toMatchObject({ kind: "skipped" });
		}
		expect(controller.maybeRequest(new FakeJob("bg_30"))).toBeUndefined();
		advance(3_600_000);
		expect(await controller.maybeRequest(new FakeJob("bg_30"))).toMatchObject({ kind: "skipped" });
		expect(requests).toHaveLength(31);
	});
});
