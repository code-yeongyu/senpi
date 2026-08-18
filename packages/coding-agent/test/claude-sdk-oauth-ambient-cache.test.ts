import { describe, expect, it, vi } from "vitest";
import { createAmbientAuthStatusReader } from "../src/core/extensions/builtin/claude-sdk-oauth/availability.ts";

describe("ambient Claude auth status cache", () => {
	it("probes once for repeated reads inside the TTL", async () => {
		const probe = vi.fn(async () => true);
		let clock = 1_000;
		const read = createAmbientAuthStatusReader(probe, () => clock, 30_000);

		expect(await read()).toBe(true);
		clock += 29_999;
		expect(await read()).toBe(true);

		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("re-probes once the TTL has elapsed", async () => {
		const probe = vi.fn(async () => true);
		let clock = 1_000;
		const read = createAmbientAuthStatusReader(probe, () => clock, 30_000);

		await read();
		clock += 30_000;
		await read();

		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("shares one in-flight probe between concurrent reads", async () => {
		let release: ((value: boolean) => void) | undefined;
		const probe = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
		const read = createAmbientAuthStatusReader(probe, () => 1_000, 30_000);

		const both = Promise.all([read(), read()]);
		release?.(true);

		expect(await both).toEqual([true, true]);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("keeps sharing an in-flight probe after its future cache TTL elapses", async () => {
		let clock = 1_000;
		const releases: Array<(value: boolean) => void> = [];
		const probe = vi.fn(() => new Promise<boolean>((resolve) => releases.push(resolve)));
		const read = createAmbientAuthStatusReader(probe, () => clock, 30_000);

		const first = read();
		clock += 30_000;
		const second = read();

		expect(probe).toHaveBeenCalledTimes(1);
		releases[0]?.(true);
		expect(await Promise.all([first, second])).toEqual([true, true]);
	});

	it("stops waiting when the caller aborts, leaving the shared probe for the others", async () => {
		let release: ((value: boolean) => void) | undefined;
		const probe = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
		const read = createAmbientAuthStatusReader(probe, () => 1_000, 30_000);
		const abandoned = new AbortController();

		const abandonedRead = read(abandoned.signal);
		const stillWaiting = read();
		abandoned.abort(new Error("turn aborted"));

		await expect(abandonedRead).rejects.toThrow("turn aborted");
		release?.(true);
		expect(await stillWaiting).toBe(true);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("rejects immediately when the caller is already aborted", async () => {
		const probe = vi.fn(async () => true);
		const read = createAmbientAuthStatusReader(probe, () => 1_000, 30_000);
		await read();

		await expect(read(AbortSignal.abort(new Error("already gone")))).rejects.toThrow("already gone");
	});

	it("does not start a cold probe for an already aborted caller", async () => {
		const probe = vi.fn(async () => true);
		const read = createAmbientAuthStatusReader(probe, () => 1_000, 30_000);

		await expect(read(AbortSignal.abort(new Error("already gone")))).rejects.toThrow("already gone");
		expect(probe).not.toHaveBeenCalled();
	});

	it("does not cache a rejected probe", async () => {
		const probe = vi.fn().mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValueOnce(true);
		const read = createAmbientAuthStatusReader(probe, () => 1_000, 30_000);

		await expect(read()).rejects.toThrow("spawn failed");
		expect(await read()).toBe(true);
		expect(probe).toHaveBeenCalledTimes(2);
	});
});
