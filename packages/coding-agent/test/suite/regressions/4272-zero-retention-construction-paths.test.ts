import { afterEach, expect, it, vi } from "vitest";
import {
	type ConstructionHost,
	FLAG,
	HOSTS,
	inProcessConstructionHost,
	storeCalls,
} from "./4272-construction-host-support.ts";
import { CONSTRUCTION_PATHS } from "./4272-construction-paths-support.ts";

// Part of #4272 (S07b, RULING-52 condition 1, X07): with the flag on, no supported construction path of a lane-owned
// session ever writes a replay-store record for it. The flag-off control runs the same assertion where no lane exists
// and sees today's retention, so the assertion can fail.

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const RETAINED_TYPES = new Set(["message_start", "message_update", "message_end", "session_lifecycle"]);

function retainable(host: ConstructionHost, sessionId: string): number {
	return host.enqueued.filter(
		(entry) => entry.sessionId === sessionId && RETAINED_TYPES.has(String(entry.record.type)),
	).length;
}

function remembered(calls: ReturnType<typeof storeCalls>, host: ConstructionHost) {
	const driven = new Set(host.driven.map(({ sessionId }) => sessionId));
	return calls.filter(({ method, sessionId }) => method === "remember" && driven.has(String(sessionId)));
}

const rows = HOSTS.flatMap(([kind, create]) =>
	CONSTRUCTION_PATHS.map(([path, drive]) => [`${kind}: ${path}`, create, drive] as const),
);

it.each(rows)(
	"zero replay retention for a lane-owned session, %s",
	async (_name, create, drive) => {
		vi.stubEnv(FLAG, "1");
		const calls = storeCalls();
		const host = await create();
		try {
			await drive(host);
			expect(host.driven.length).toBeGreaterThan(0);
			for (const { sessionId, laneOwned } of host.driven) {
				expect(laneOwned, `${sessionId} was routed through its acceptance lane during its turn`).toBe(true);
				expect(
					retainable(host, sessionId),
					`${sessionId} produced records a lane-less session retains`,
				).toBeGreaterThan(0);
			}
			expect(remembered(calls, host)).toEqual([]);
		} finally {
			await host.dispose();
		}
	},
	120_000,
);

it("control: the same in-process open with the flag off owns no lane, and the same assertion sees today's retention", async () => {
	const calls = storeCalls();
	const host = await inProcessConstructionHost();
	try {
		host.connect("a");
		const opened = await host.open("a");
		await host.turn(opened.sessionId, "a");
		expect(host.driven).toEqual([{ sessionId: opened.sessionId, laneOwned: false }]);
		expect(remembered(calls, host).length).toBeGreaterThan(0);
	} finally {
		await host.dispose();
	}
}, 120_000);
