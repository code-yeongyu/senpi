import { afterEach, describe, expect, it, vi } from "vitest";
import * as processIdentity from "../../src/modes/app-server/daemon/process.ts";
import { callerHostOwner, hostOwnerGone, sameHostOwner } from "../../src/modes/rpc/host-daemon-state.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #3044: only a confirmed absence or a readable OS start-identity mismatch permits prompt exit.
describe("RPC owner OS identity fallback", () => {
	const owner = { pid: 42, startTime: "Fri Oct  9 12:00:00 2026" };

	it.each([
		{ observation: { kind: "absent" as const }, gone: true },
		{ observation: { kind: "present" as const, identity: owner.startTime }, gone: false },
		{ observation: { kind: "present" as const, identity: "Fri Oct  9 12:00:04 2026" }, gone: true },
		{ observation: { kind: "error" as const, error: new Error("OS query failed") }, gone: false },
		{ observation: { kind: "present" as const, identity: "unreadable" }, gone: false },
	])("reports gone=$gone for $observation", async ({ observation, gone }) => {
		vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue(observation);
		expect(await hostOwnerGone(owner)).toBe(gone);
	});

	it("compares Windows FILETIME identities without uptime-derived estimates", async () => {
		vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue({
			kind: "present",
			identity: "134044416040000000",
		});
		expect(await hostOwnerGone({ pid: 42, startTime: "134044416000000000" })).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"keeps a live owner alive across different capture and observer timezones",
		async () => {
			vi.stubEnv("TZ", "Pacific/Honolulu");
			const captured = await callerHostOwner();
			vi.stubEnv("TZ", "Asia/Tokyo");
			expect(await hostOwnerGone(captured)).toBe(false);
		},
	);

	it("compares the instant rather than two equivalent timestamp spellings", async () => {
		vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue({
			kind: "present",
			identity: "Fri Oct 9 12:00:00 2026 UTC",
		});
		expect(await hostOwnerGone({ pid: 42, startTime: "2026-10-09T12:00:00.000Z" })).toBe(false);
	});

	it("honors the existing process-start comparison tolerance", async () => {
		vi.spyOn(processIdentity, "readProcessIdentity").mockResolvedValue({
			kind: "present",
			identity: "134044416030000000",
		});
		expect(await hostOwnerGone({ pid: 42, startTime: "134044416000000000" })).toBe(false);
	});

	it.each([
		{ startTime: "Fri Oct 9 12:00:00 2026 UTC", same: true },
		{ startTime: "2026-10-09T12:00:02.000Z", same: false },
	])("keeps pipe binding identity distinct from liveness tolerance: $same", ({ startTime, same }) => {
		expect(sameHostOwner({ pid: 42, startTime: "2026-10-09T12:00:00.000Z" }, { pid: 42, startTime })).toBe(same);
	});
});
