// CONF.bun (senpi#4740): the Bun SQLite host. Every registered case runs on it, with no skip: the STORE-* and
// KILL-STORE-* cases on a fresh medium of packages/session-backends/sqlite-bun through the exported
// StoreConformanceAdapter; the WAKE, KILL-WAKE and MULTI-HOST cases on the Bun timer host (manual clock) whose alarm
// persists in that SQLite store; the TRANSPORT, MULTI-LANE/FAIR and FAULT-TRANSPORT cases on the reference reliable
// transport. Bun-only: it imports bun:sqlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunSqliteMedia } from "../../../../session-backends/sqlite-bun/src/index.ts";
import type { ConformanceHost } from "../../../src/conformance/runner.ts";
import { createManualTimers } from "../../../src/durable/testing/manual-timers.ts";
import type { WakeCaseAdapters, WakeConformanceAdapter } from "../../../src/durable/testing/wake-harness.ts";
import { createBunTimerHost } from "../../../src/durable/wake-host-bun-timer.ts";
import { storeAlarmPersistence } from "../../../src/durable/wake-host-store-alarm.ts";
import { createReliableTransport, decodeReferencePacket } from "../../../src/transport/reliable-transport.ts";
import type {
	TransportCaseAdapters,
	TransportConformanceAdapter,
} from "../../../src/transport/testing/transport-harness.ts";

export type BunSqliteHostAdapters = WakeCaseAdapters & TransportCaseAdapters;

const T0 = 1_800_000_000_000;
const rethrow = (_key: string, error: unknown): never => {
	throw error;
};

function bunTimerWake(): WakeConformanceAdapter {
	const timers = createManualTimers(T0);
	const openHost = () => createBunTimerHost({ now: timers.now, setTimer: timers.setTimer, onFireError: rethrow });
	let host = openHost();
	return {
		now: timers.now,
		advanceTo: timers.advanceTo,
		openAlarm: ({ medium, store, epoch, onFire, options }) =>
			host.openAlarm(medium, storeAlarmPersistence(store, epoch), onFire, options),
		restart: async () => {
			host.close();
			host = openHost();
		},
	};
}

const referenceTransport: TransportConformanceAdapter = {
	createSide: (clock) =>
		createReliableTransport({
			clock,
			window: 8,
			retransmitMs: 200,
			onHandlerError: (error) => {
				throw error;
			},
		}),
	decode: decodeReferencePacket,
};

export function createBunSqliteHost(): ConformanceHost<BunSqliteHostAdapters> {
	const media = createBunSqliteMedia(mkdtempSync(join(tmpdir(), "conf-bun-sqlite-")));
	return {
		name: "bun-sqlite",
		provides: ["store", "wake", "transport"],
		adapters: { store: media, wake: bunTimerWake(), transport: referenceTransport, platform: process.platform },
	};
}
