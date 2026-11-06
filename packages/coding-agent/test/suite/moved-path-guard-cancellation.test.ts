import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMovedPathProbe } from "../../src/core/extensions/builtin/moved-path-guard/resolve-async.ts";
import { breadcrumbBody, createMovedLayout, type MovedLayout, writeBreadcrumb } from "./moved-path-guard-fixtures.ts";

const pending = vi.hoisted(() => ({
	signal: undefined as AbortSignal | undefined,
	release: undefined as ((path: string) => void) | undefined,
	homeError: "",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: (path: string) =>
			path === pending.homeError ? Promise.reject(new Error("home unavailable")) : actual.realpath(path),
	};
});
vi.mock("../../src/core/tools/filesystem-policy.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/tools/filesystem-policy.ts")>();
	return {
		...actual,
		canonicalizeFilesystemPath: (path: string, signal?: AbortSignal) => {
			if (!path.includes("SLOW")) return actual.canonicalizeFilesystemPath(path, signal);
			pending.signal = signal;
			return new Promise<string>((release) => {
				pending.release = release;
			});
		},
	};
});

describe("moved path probe cancellation (#3404)", () => {
	let layout: MovedLayout | undefined;
	afterEach(() => {
		vi.useRealTimers();
		layout?.cleanup();
		layout = undefined;
		pending.signal = undefined;
		pending.release = undefined;
		pending.homeError = "";
	});

	it("cancels expired canonicalization while preserving a moved-path decision", async () => {
		layout = createMovedLayout();
		const probe = createMovedPathProbe();
		const path = join(layout.oldWorktree, "SLOW");
		vi.useFakeTimers();
		const result = probe.resolve(path);

		await vi.advanceTimersByTimeAsync(501);
		vi.useRealTimers();
		const moved = await result;

		expect(pending.signal?.aborted).toBe(true);
		expect(probe.timedOut).toBe(true);
		expect(moved?.mappedPath).toBe(join(layout.newWorktree, "SLOW"));
	});

	it("cancels in-flight resolution when the whole probe stops", async () => {
		layout = createMovedLayout();
		const probe = createMovedPathProbe();
		const path = join(layout.home, "SLOW");
		const result = probe.resolve(path);

		probe.stop();
		pending.release?.(path);

		expect(await result).toBeUndefined();
		expect(pending.signal?.aborted).toBe(true);
		expect(probe.stopped).toBe(true);
	});

	it("starts no canonicalization after a probe was stopped", async () => {
		layout = createMovedLayout();
		const probe = createMovedPathProbe();
		probe.stop();

		expect(await probe.resolve(join(layout.home, "SLOW"))).toBeUndefined();
		expect(pending.signal).toBeUndefined();
	});

	it("keeps the home spelling when home canonicalization fails", async () => {
		layout = createMovedLayout();
		pending.homeError = layout.home;
		const probe = createMovedPathProbe();

		expect((await probe.resolve(join(layout.oldSessions, "file.jsonl")))?.mappedPath).toBe(
			join(layout.newSessions, "file.jsonl"),
		);
	});

	it("checks a trusted non-legacy root without following its directory link", async () => {
		layout = createMovedLayout();
		const oldRoot = join(layout.home, "old-data");
		writeBreadcrumb(oldRoot, breadcrumbBody(layout.newRoot, ["userdata/omo-sessions"]));
		const probe = createMovedPathProbe();

		expect((await probe.resolve(join(oldRoot, "userdata", "omo-sessions", "file.jsonl")))?.mappedPath).toBe(
			join(layout.newSessions, "file.jsonl"),
		);
	});
});
