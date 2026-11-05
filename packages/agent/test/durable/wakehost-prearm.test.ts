// senpi#4733 (R1.d, R17.a): WakeHost pre-arm ordering, the Bun timer host, and the WAKE, KILL-WAKE and MULTI-HOST
// conformance cases on the memory store, through the suite runner.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildManifest, findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { type CaseImplementation, type HostReport, runSuite } from "../../src/conformance/runner.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { KILL_WAKE_CASES, KILL_WAKE_DECLARATIONS } from "../../src/durable/testing/kill-wake.ts";
import { MULTI_HOST_CASES } from "../../src/durable/testing/multi-host-cases.ts";
import type { StoreConformanceAdapter } from "../../src/durable/testing/store-harness.ts";
import { WAKE_CASES } from "../../src/durable/testing/wake-cases.ts";
import { createManualTimers } from "../../src/durable/testing/manual-timers.ts";
import type { WakeCaseAdapters, WakeConformanceAdapter } from "../../src/durable/testing/wake-harness.ts";
import type { WakeAlarm } from "../../src/durable/wake-host.ts";
import { createBunTimerHost } from "../../src/durable/wake-host-bun-timer.ts";
import { storeAlarmPersistence } from "../../src/durable/wake-host-store-alarm.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const readRepoFile = async (path: string): Promise<Uint8Array> => readFile(`${REPO_ROOT}${path}`);

const IMPLEMENTATIONS = new Map<string, CaseImplementation<WakeCaseAdapters>>([
	...WAKE_CASES,
	...KILL_WAKE_CASES,
	...MULTI_HOST_CASES,
]);
const WAKE_REGISTRY = CONFORMANCE_REGISTRY.filter((entry) => /^(KILL-)?WAKE-|^MULTI-HOST-/.test(entry.id));
const WAKE_IDS = ["WAKE-01", "WAKE-02", "WAKE-03", "WAKE-RET-01"];
const KILL_IDS = ["01", "02", "03", "04", "05", "06", "07", "08"].map((n) => `KILL-WAKE-${n}`);
const T0 = 1_800_000_000_000;
const rethrow = (_key: string, error: unknown): never => {
	throw error;
};

function memoryStores(): StoreConformanceAdapter {
	const media = new Map<string, MemoryStoreMedium>();
	return {
		createMedium: async () => {
			const name = `medium-${media.size + 1}`;
			media.set(name, createMemoryStoreMedium());
			return name;
		},
		open: async (name, options) => {
			const medium = media.get(name);
			if (medium === undefined) throw new Error(`no memory medium named ${name}`);
			return openMemoryStore(medium, options);
		},
	};
}

interface HostShape {
	readonly alarmKey?: (medium: string) => string;
	readonly wrap?: (alarm: WakeAlarm) => WakeAlarm;
}

function memoryHost(shape: HostShape = {}): WakeCaseAdapters {
	const timers = createManualTimers(T0);
	const openHost = () => createBunTimerHost({ now: timers.now, setTimer: timers.setTimer, onFireError: rethrow });
	let host = openHost();
	const wake: WakeConformanceAdapter = {
		now: timers.now,
		advanceTo: timers.advanceTo,
		openAlarm: async ({ medium, store, epoch, onFire, options }) => {
			const key = shape.alarmKey?.(medium) ?? medium;
			const alarm = await host.openAlarm(key, storeAlarmPersistence(store, epoch), onFire, options);
			return shape.wrap?.(alarm) ?? alarm;
		},
		restart: async () => {
			host.close();
			host = openHost();
		},
	};
	return { store: memoryStores(), wake };
}

async function runOnMemory(shape?: HostShape): Promise<HostReport> {
	const manifest = await buildManifest(WAKE_REGISTRY, readRepoFile);
	return runSuite(
		manifest,
		{ name: "memory", provides: ["store", "wake"], adapters: memoryHost(shape) },
		IMPLEMENTATIONS,
	);
}

describe("the WAKE, KILL-WAKE and MULTI-HOST registration", () => {
	it("registers every case with its implementation file, each needing a store and a wake host", () => {
		const testing = "packages/agent/src/durable/testing";
		expect(WAKE_REGISTRY.map((entry) => [entry.id, entry.impl, entry.adapters])).toEqual([
			...WAKE_IDS.map((id) => [id, `${testing}/wake-cases.ts`, ["store", "wake"]]),
			["MULTI-HOST-01", `${testing}/multi-host-cases.ts`, ["store", "wake"]],
			...KILL_IDS.map((id) => [id, `${testing}/kill-wake.ts`, ["store", "wake"]]),
		]);
	});

	it("has an implementation for every registered case and a registered case for every implementation", () => {
		expect(findImplementationGaps(WAKE_REGISTRY, IMPLEMENTATIONS)).toEqual({ unimplemented: [], unregistered: [] });
	});

	it("declares a kill around every arm, commit and fire", () => {
		expect(KILL_WAKE_DECLARATIONS.map(({ id, operation, placement }) => `${id} ${operation} ${placement}`)).toEqual([
			"KILL-WAKE-01 admit everywhere",
			"KILL-WAKE-02 admit everywhere",
			"KILL-WAKE-03 commit everywhere",
			"KILL-WAKE-04 update everywhere",
			"KILL-WAKE-05 fire everywhere",
			"KILL-WAKE-06 fire everywhere",
			"KILL-WAKE-07 fire everywhere",
			"KILL-WAKE-08 admit everywhere",
		]);
	});
});

describe("the memory store on the Bun timer host", () => {
	let report: HostReport;
	beforeAll(async () => {
		report = await runOnMemory();
	});

	for (const id of [...WAKE_IDS, "MULTI-HOST-01", ...KILL_IDS]) {
		it(`passes ${id}`, () => {
			expect(report.results.find((result) => result.id === id)).toEqual({ id, status: "pass" });
		});
	}
});

describe("the cases fail a host that breaks the contract", () => {
	const rows: ReadonlyArray<{ name: string; shape: HostShape; failing: string[] }> = [
		{
			name: "keeps one alarm for every session",
			shape: { alarmKey: () => "one alarm" },
			failing: ["MULTI-HOST-01"],
		},
		{
			name: "ignores clears",
			shape: { wrap: (alarm) => ({ read: () => alarm.read(), set: (at) => alarm.set(at), clear: async () => {} }) },
			failing: [
				"WAKE-01",
				"WAKE-02",
				"WAKE-03",
				"WAKE-RET-01",
				"MULTI-HOST-01",
				"KILL-WAKE-01",
				"KILL-WAKE-02",
				"KILL-WAKE-03",
				"KILL-WAKE-04",
				"KILL-WAKE-05",
				"KILL-WAKE-06",
				"KILL-WAKE-07",
				"KILL-WAKE-08",
			],
		},
	];

	for (const row of rows) {
		it(`fails exactly the cases that observe a host that ${row.name}`, async () => {
			const failed = (await runOnMemory(row.shape)).results.filter((r) => r.status === "fail").map((r) => r.id);
			expect(failed).toEqual(row.failing);
		});
	}
});
