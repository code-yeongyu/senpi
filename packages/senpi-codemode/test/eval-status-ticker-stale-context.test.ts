import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalStatusTicker } from "../src/extension/eval-status-ticker.ts";
import type { EvalDetachedCellStatusEntry } from "../src/tool/detached-cell-manager.ts";

/** The two messages the host's runner retires a context with (reload, then disposed replacement). */
const RELOAD_STALE_MESSAGE = "stale extension generation after reload";
const REPLACEMENT_STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const T0 = 1_000_000;
const entry: EvalDetachedCellStatusEntry = { cellId: "cell-1", language: "py", summary: "long cell", startedAtMs: T0 };

describe("#2549 EvalStatusTicker vs a retired extension context", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		["reload", RELOAD_STALE_MESSAGE],
		["replacement", REPLACEMENT_STALE_MESSAGE],
	])("retires instead of throwing when a %s retires the render context", (_label, message) => {
		vi.useFakeTimers();
		let now = T0;
		let renders = 0;
		const ticker = new EvalStatusTicker({
			now: () => now,
			render: () => {
				renders += 1;
				if (renders > 1) throw new Error(message);
			},
		});
		ticker.sync([entry]);

		now += 1_000;
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		expect(ticker.running).toBe(false);
		now += 5_000;
		vi.advanceTimersByTime(5_000);
		expect(renders).toBe(2);
	});

	it("re-arms on the next sync once a live context renders again", () => {
		vi.useFakeTimers();
		let now = T0;
		let stale = false;
		const labels: Array<string | undefined> = [];
		const ticker = new EvalStatusTicker({
			now: () => now,
			render: (status) => {
				if (stale) throw new Error(REPLACEMENT_STALE_MESSAGE);
				labels.push(status);
			},
		});
		ticker.sync([entry]);
		stale = true;
		now += 1_000;
		vi.advanceTimersByTime(1_000);
		expect(ticker.running).toBe(false);

		stale = false;
		ticker.sync([entry]);
		now += 1_000;
		vi.advanceTimersByTime(1_000);

		expect(ticker.running).toBe(true);
		expect(labels).toEqual(["↗ py · long cell (0s)", "↗ py · long cell (1s)", "↗ py · long cell (2s)"]);
	});

	it("does not re-arm a sync whose immediate render hit the retired context", () => {
		vi.useFakeTimers();
		const ticker = new EvalStatusTicker({
			now: () => T0,
			render: () => {
				throw new Error(RELOAD_STALE_MESSAGE);
			},
		});

		expect(() => ticker.sync([entry])).not.toThrow();
		expect(ticker.running).toBe(false);
	});

	it("still surfaces a render failure that is not a retired context", () => {
		vi.useFakeTimers();
		let now = T0;
		let renders = 0;
		const ticker = new EvalStatusTicker({
			now: () => now,
			render: () => {
				renders += 1;
				if (renders > 1) throw new Error("disk exploded");
			},
		});
		ticker.sync([entry]);

		now += 1_000;
		expect(() => vi.advanceTimersByTime(1_000)).toThrow("disk exploded");
	});
});
