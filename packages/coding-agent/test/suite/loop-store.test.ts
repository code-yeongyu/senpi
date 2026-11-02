import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const writeFault = vi.hoisted(() => ({
	failOnPathContaining: undefined as string | undefined,
	partialContents: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			const target = String(args[0]);
			if (writeFault.failOnPathContaining !== undefined && target.includes(writeFault.failOnPathContaining)) {
				writeFault.failOnPathContaining = undefined;
				// Simulate a crash mid-write: partial bytes hit the temp file, then the write fails.
				await actual.writeFile(target, writeFault.partialContents, "utf8");
				throw new Error("simulated mid-write failure");
			}
			return actual.writeFile(...args);
		},
	};
});

import {
	InvalidLoopStoreError,
	loadLoopState,
	loopStateFilePath,
	mutateLoopState,
	readLoopState,
	snapshotLoopState,
	UnsupportedLoopStoreVersionError,
} from "../../src/core/extensions/builtin/loop/store.ts";
import type {
	DynamicCronEntry,
	FixedCronEntry,
	LoopEndReason,
	LoopFileFingerprint,
	LoopState,
	LoopStoreRef,
	SentinelDeliveryState,
} from "../../src/core/extensions/builtin/loop/types.ts";
import { LOOP_END_REASONS, LOOP_STATE_VERSION } from "../../src/core/extensions/builtin/loop/types.ts";

const tempDirs: string[] = [];

async function tempStore(sessionId = "session-test"): Promise<LoopStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-loop-store-"));
	tempDirs.push(dir);
	return { baseDir: join(dir, "extensions", "loop"), sessionId };
}

const fingerprint: LoopFileFingerprint = {
	path: "/repo/.senpi/loop.md",
	mtimeMs: 1_755_000_000_000,
	size: 128,
	contentHash: "a".repeat(64),
	anchorDeliveryId: "delivery-anchor-1",
};

const sentinelDelivery: SentinelDeliveryState = {
	autonomousPreambleDelivered: true,
	lastLoopFileDelivered: fingerprint,
	forceFullDelivery: false,
};

function fixedEntry(overrides: Partial<FixedCronEntry> = {}): FixedCronEntry {
	return {
		id: "loop-fixed-1",
		kind: "fixed",
		phase: "waiting",
		originalArgs: "5m /babysit-prs",
		reentryPrompt: "/loop 5m /babysit-prs",
		payload: { type: "prompt", prompt: "/babysit-prs" },
		createdAt: 1_755_000_000_000,
		lastFiredAt: 1_755_000_300_000,
		expiresAt: 1_755_604_800_000,
		lastScheduledForAt: 1_755_000_300_000,
		coalescedFirePending: true,
		queuedForAt: 1_755_000_600_000,
		noopStreak: 0,
		tickCount: 7,
		sentinelDelivery,
		wakeSources: [
			{ source: "terminal-monitor", id: "monitor-1", description: "watch build", createdAt: 1_755_000_000_000 },
		],
		requestedInterval: { value: 90, unit: "m", raw: "90m" },
		effectiveInterval: {
			value: 2,
			unit: "h",
			human: "every 2 hours",
			rounded: true,
			roundingNotice: "requested 90m, rounded to every 2 hours",
		},
		cronExpression: "0 */2 * * *",
		nextFireAt: 1_755_000_600_000,
		intervalMs: 7_200_000,
		...overrides,
	} as FixedCronEntry;
}

function dynamicEntry(overrides: Partial<DynamicCronEntry> = {}): DynamicCronEntry {
	return {
		id: "loop-dynamic-1",
		kind: "dynamic",
		phase: "waiting",
		originalArgs: "",
		reentryPrompt: "/loop",
		payload: { type: "sentinel", sentinel: "<<loop.md-dynamic>>" },
		createdAt: 1_755_000_000_000,
		lastFiredAt: null,
		expiresAt: 1_755_604_800_000,
		lastScheduledForAt: null,
		coalescedFirePending: false,
		queuedForAt: null,
		noopStreak: 3,
		tickCount: 2,
		sentinelDelivery: { ...sentinelDelivery, lastLoopFileDelivered: null, forceFullDelivery: true },
		wakeSources: [],
		pendingWakeup: {
			id: "wakeup-1",
			loopId: "loop-dynamic-1",
			kind: "dynamic",
			source: "model",
			requestedDelaySeconds: 30,
			delaySeconds: 60,
			dueAt: 1_755_000_060_000,
			reason: "poll the deploy",
			prompt: "check the deploy",
			noop: true,
			createdAt: 1_755_000_000_000,
		},
		keepaliveCredit: 1,
		...overrides,
	} as DynamicCronEntry;
}

function populatedState(ref: LoopStoreRef): LoopState {
	const fixed = fixedEntry();
	const dynamic = dynamicEntry();
	const ended = fixedEntry({
		id: "loop-fixed-ended",
		phase: "ended",
		endedAt: 1_755_000_900_000,
		endReason: "tick_budget_exhausted",
		endDetail: "reached the 2000 tick budget",
	});
	return {
		version: LOOP_STATE_VERSION,
		sessionId: ref.sessionId,
		entries: { [fixed.id]: fixed, [dynamic.id]: dynamic, [ended.id]: ended },
		activeDynamicId: dynamic.id,
		updatedAt: 1_755_000_900_000,
	};
}

async function writeRawLoopFile(ref: LoopStoreRef, contents: string): Promise<void> {
	const filePath = loopStateFilePath(ref);
	await rm(filePath, { force: true });
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, contents, "utf8");
}

afterEach(async () => {
	writeFault.failOnPathContaining = undefined;
	writeFault.partialContents = "";
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loop end reasons", () => {
	it("has exactly the five supported terminal reasons and no session_closed", () => {
		// Given / When
		const reasons: readonly LoopEndReason[] = LOOP_END_REASONS;

		// Then
		expect([...reasons].sort()).toEqual(
			["error", "expired", "keepalive_exhausted", "stopped", "tick_budget_exhausted"].sort(),
		);
		expect(reasons).not.toContain("session_closed");
	});
});

describe("loop store round trip", () => {
	it("preserves every persisted field across write and load", async () => {
		// Given
		const ref = await tempStore("session-round-trip");
		const state = populatedState(ref);

		// When
		await mutateLoopState(ref, () => state);
		const loaded = await loadLoopState(ref);

		// Then
		expect(loaded).toEqual(state);
	});

	it("returns an empty versioned state when nothing has been persisted", async () => {
		// Given
		const ref = await tempStore("session-empty");

		// When
		const loaded = await loadLoopState(ref);

		// Then
		expect(loaded).toEqual({
			version: LOOP_STATE_VERSION,
			sessionId: ref.sessionId,
			entries: {},
			activeDynamicId: null,
			updatedAt: 0,
		});
		expect(await readLoopState(ref)).toBeNull();
	});

	it("exposes the last loaded state through a synchronous snapshot", async () => {
		// Given
		const ref = await tempStore("session-snapshot");
		const state = populatedState(ref);
		expect(snapshotLoopState(ref)).toBeUndefined();

		// When
		await mutateLoopState(ref, () => state);

		// Then
		expect(snapshotLoopState(ref)).toEqual(state);
	});
});

describe("loop store fail-closed parsing", () => {
	it("rejects a wrong store version instead of resetting the file", async () => {
		// Given
		const ref = await tempStore("session-wrong-version");
		const raw = `${JSON.stringify({ ...populatedState(ref), version: 2 })}\n`;
		await writeRawLoopFile(ref, raw);

		// When / Then
		await expect(loadLoopState(ref)).rejects.toBeInstanceOf(UnsupportedLoopStoreVersionError);
		expect(await readFile(loopStateFilePath(ref), "utf8")).toBe(raw);
	});

	it("rejects corrupt JSON instead of resetting the file", async () => {
		// Given
		const ref = await tempStore("session-corrupt-json");
		const raw = '{"version":1,"entries":';
		await writeRawLoopFile(ref, raw);

		// When / Then
		await expect(loadLoopState(ref)).rejects.toBeInstanceOf(InvalidLoopStoreError);
		expect(await readFile(loopStateFilePath(ref), "utf8")).toBe(raw);
	});

	it("rejects a structurally invalid entry instead of arming a partial state", async () => {
		// Given
		const ref = await tempStore("session-invalid-entry");
		const broken = { ...populatedState(ref) } as unknown as Record<string, unknown>;
		broken.entries = { "loop-fixed-1": { id: "loop-fixed-1", kind: "fixed" } };
		await writeRawLoopFile(ref, `${JSON.stringify(broken)}\n`);

		// When / Then
		await expect(loadLoopState(ref)).rejects.toBeInstanceOf(InvalidLoopStoreError);
	});

	it("rejects an activeDynamicId that does not name a dynamic entry", async () => {
		// Given
		const ref = await tempStore("session-dangling-dynamic");
		const state = populatedState(ref);
		await writeRawLoopFile(ref, `${JSON.stringify({ ...state, activeDynamicId: "loop-fixed-1" })}\n`);

		// When / Then
		await expect(loadLoopState(ref)).rejects.toBeInstanceOf(InvalidLoopStoreError);
	});

	it("fails a mutation closed when existing state is corrupt", async () => {
		// Given
		const ref = await tempStore("session-corrupt-mutate");
		await writeRawLoopFile(ref, "{not json at all");

		// When / Then
		await expect(mutateLoopState(ref, (current) => current)).rejects.toBeInstanceOf(InvalidLoopStoreError);
	});
});

describe("loop store mutation serialization", () => {
	it("lands both concurrent mutations without a lost update", async () => {
		// Given
		const ref = await tempStore("session-concurrent");
		await mutateLoopState(ref, (current) => ({ ...current, entries: {} }));

		// When: both mutations are started before either resolves.
		const first = mutateLoopState(ref, async (current) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			const entry = fixedEntry({ id: "loop-a" });
			return { ...current, entries: { ...current.entries, [entry.id]: entry }, updatedAt: 1 };
		});
		const second = mutateLoopState(ref, async (current) => {
			const entry = fixedEntry({ id: "loop-b" });
			return { ...current, entries: { ...current.entries, [entry.id]: entry }, updatedAt: 2 };
		});
		await Promise.all([first, second]);

		// Then
		const loaded = await loadLoopState(ref);
		expect(Object.keys(loaded.entries).sort()).toEqual(["loop-a", "loop-b"]);
	});

	it("keeps later mutations running after an earlier mutation throws", async () => {
		// Given
		const ref = await tempStore("session-mutation-error");

		// When
		const failing = mutateLoopState(ref, () => {
			throw new Error("mutation exploded");
		});
		const succeeding = mutateLoopState(ref, (current) => {
			const entry = dynamicEntry({ id: "loop-after-error" });
			return {
				...current,
				entries: { [entry.id]: entry },
				activeDynamicId: entry.id,
				updatedAt: 5,
			};
		});

		// Then
		await expect(failing).rejects.toThrow("mutation exploded");
		await succeeding;
		const loaded = await loadLoopState(ref);
		expect(Object.keys(loaded.entries)).toEqual(["loop-after-error"]);
		expect(loaded.activeDynamicId).toBe("loop-after-error");
	});
});

describe("loop store atomic writes", () => {
	it("leaves no partial file observable after a simulated mid-write failure", async () => {
		// Given: a committed state that must survive the failed write.
		const ref = await tempStore("session-atomic");
		const committed = populatedState(ref);
		await mutateLoopState(ref, () => committed);

		// When: the next write dies partway through writing its temp file.
		writeFault.failOnPathContaining = ".loop-";
		writeFault.partialContents = '{"version":1,"sessionId":"session-atomic","entr';
		const failed = mutateLoopState(ref, (current) => ({
			...current,
			entries: {},
			activeDynamicId: null,
			updatedAt: 9,
		}));

		// Then: the failure surfaces, the committed file is untouched, and no temp debris remains.
		await expect(failed).rejects.toThrow("simulated mid-write failure");
		expect(await loadLoopState(ref)).toEqual(committed);
		const leftovers = await readdir(dirname(loopStateFilePath(ref)));
		expect(leftovers).toEqual([`${encodeURIComponent(ref.sessionId)}.json`]);
	});
});
