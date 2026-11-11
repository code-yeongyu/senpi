import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type JobWidgetAuthor,
	JobWidgetRegistry,
	type JobWidgetState,
	PUBLISH_INTERVAL_MS,
	TextTap,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";

const SPEC = {
	title: "Blender render",
	rules: [{ from: "out", match: String.raw`^\s*Time: \d+:(?P<frame_s>[\d.]+) \(Saving`, count: "frames" }],
	blocks: [{ kind: "spark", field: "frame_s", label: "seconds per frame", unit: "s" }],
	headline: { field: "frames", agg: "count", label: "rendered" },
};

const frameLine = (frame: number): string =>
	`Fra:${frame} Mem:2104.32M | Rendering 64 / 64 samples\n Time: 00:0${frame % 10}.90 (Saving: 00:00.09)\n`;

interface Sent {
	readonly at: number;
	readonly state: JobWidgetState;
}

function setup(author: JobWidgetAuthor = async () => SPEC) {
	const sent: Sent[] = [];
	const registry = new JobWidgetRegistry({
		sessionId: "session_1",
		author,
		publish: (state) => sent.push({ at: Date.now(), state }),
		limits: { authorAfterMs: 15_000 },
	});
	const tap = new TextTap("out", "command output");
	const handle = registry.add({
		id: "bash_1",
		kind: "bash",
		sources: [tap],
		brief: { command: "blender -b scene.blend -a" },
		startedAtMs: Date.now(),
	});
	const write = (text: string): void => {
		tap.append(text);
		handle.notify();
	};
	return { registry, tap, handle, sent, write };
}

const states = (sent: readonly Sent[]) => sent.map(({ state }) => state.jobs.map((job) => job.state).join(","));

describe("job widget registry", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a running row from the start, then pending and live once the job is old enough, at most once a second", async () => {
		const { registry, sent, write } = setup();
		for (let frame = 1; frame <= 200; frame++) {
			write(frameLine(frame));
			await vi.advanceTimersByTimeAsync(100);
		}
		registry.dispose();

		const distinct = states(sent).filter((state, index, all) => state !== all[index - 1]);
		expect(distinct[0]).toBe("fallback");
		expect(distinct.at(-1)).toBe("live");
		expect(distinct.filter((state) => state !== "pending")).toEqual(["fallback", "live"]);
		for (let index = 1; index < sent.length; index++) {
			expect(sent[index].at - sent[index - 1].at).toBeGreaterThanOrEqual(PUBLISH_INTERVAL_MS);
		}
		// 20 s of output, 200 chunks: the running row ticks once a second, never faster.
		expect(sent.length).toBeLessThanOrEqual(21);
		expect(sent.at(-1)?.state.jobs[0]?.view?.headline).toEqual({ text: "200", label: "rendered" });
	});

	it("sends nothing while the drawn view stays the same", async () => {
		const { registry, sent, write, handle } = setup();
		write(frameLine(1) + frameLine(2) + frameLine(3));
		await vi.advanceTimersByTimeAsync(16_000);
		const settledCount = sent.length;
		expect(states(sent).at(-1)).toBe("live");

		for (let tick = 0; tick < 10; tick++) {
			handle.notify();
			await vi.advanceTimersByTimeAsync(1000);
		}
		expect(sent.length).toBe(settledCount);
		registry.dispose();
	});

	// A background job that prints nothing, or whose spec request never comes (skipped, held back by a
	// session cap, or failed), used to have no row at all, so a long silent job looked like nothing was running.
	it("lists a running bash job with its start time before and after the author skips it", async () => {
		const { registry, sent, handle } = setup(async () => ({ skip: "no quantity" }));
		expect(registry.snapshot().jobs).toMatchObject([
			{ id: "bash_1", state: "fallback", startedAtMs: 1_000_000, view: { title: "blender -b scene.blend -a" } },
		]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sent.at(-1)?.state.jobs.map((job) => job.id)).toEqual(["bash_1"]);

		const tap = new TextTap("out2", "command output");
		const talky = registry.add({ id: "bash_2", kind: "bash", sources: [tap], brief: { command: "make" } });
		tap.append("a\nb\nc\n");
		talky.notify();
		await vi.advanceTimersByTimeAsync(16_000);
		expect(registry.snapshot().jobs.find((job) => job.id === "bash_2")).toMatchObject({ state: "fallback" });

		handle.settle();
		talky.settle();
		expect(registry.snapshot().jobs.map((job) => [job.id, job.state])).toEqual([["bash_2", "skipped"]]);
		registry.dispose();
	});

	it("keeps a task job out of the state until its spec is asked for", () => {
		const { registry } = setup();
		registry.add({ id: "st_1", kind: "task", sources: [], brief: { task: "refactor" } });
		expect(registry.snapshot().jobs.map((job) => job.id)).toEqual(["bash_1"]);
		registry.dispose();
	});

	it("freezes a settled job as done and drops a disposed one", async () => {
		const { registry, sent, write, handle, tap } = setup();
		write(frameLine(1) + frameLine(2) + frameLine(3));
		await vi.advanceTimersByTimeAsync(16_000);
		tap.close();
		handle.settle();
		await vi.advanceTimersByTimeAsync(1000);
		expect(states(sent).at(-1)).toBe("done");

		handle.dispose();
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent.at(-1)?.state.jobs).toEqual([]);
		expect(registry.snapshot().jobs).toEqual([]);
		registry.dispose();
	});
});
