import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { type RegisteredHost, writeHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { readFileOrUndefined } from "../../src/modes/rpc/host-daemon-state.ts";
import { stopHost } from "../../src/modes/rpc/host-stop.ts";
import { readProcessStartTime } from "../../src/utils/process-identity.ts";

const probes = vi.hoisted(() => ({ protocol: vi.fn(), sessions: vi.fn() }));
vi.mock("../../src/modes/rpc/host-probe.ts", () => ({
	probeProtocolInfo: probes.protocol,
	probeSessionCount: probes.sessions,
}));

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "stop-generation-"));
	probes.protocol.mockReset().mockResolvedValue(undefined);
	probes.sessions.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const socket = join(root, "r.sock");
	const paths = createHostDaemonPaths({ socket, agentDir: root });
	const start = await readProcessStartTime(process.pid);
	if (start === undefined) throw new Error("fixture process identity unavailable");
	const expectedGeneration = { instanceId: "confirmed", generation: 7, pid: process.pid, processStartTime: start };
	const register = (change: Partial<RegisteredHost> = {}) =>
		writeHostRegistration(paths, {
			socket,
			instanceId: expectedGeneration.instanceId,
			generation: expectedGeneration.generation,
			record: { pid: process.pid, processStartTime: start },
			launchProfileId: "test",
			...change,
		});
	await register();
	// This test's process is the registered target; observe signals without terminating the runner.
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	return { socket, paths, expectedGeneration, register, kill };
}

// desktop#3561: confirmation authorizes one generation, not whichever registration a later stop finds.
describe("generation-bound operator stop", () => {
	it.each(["instanceId", "generation", "pid", "processStartTime"] as const)(
		"refuses a stale %s without writing an intent or signalling",
		async (field) => {
			const qa = await fixture();
			const expectedGeneration = {
				...qa.expectedGeneration,
				...(field === "instanceId" ? { instanceId: "earlier" } : {}),
				...(field === "generation" ? { generation: 6 } : {}),
				...(field === "pid" ? { pid: process.pid + 1 } : {}),
				...(field === "processStartTime" ? { processStartTime: "earlier" } : {}),
			};
			expect(await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration })).toEqual({
				action: "refuse",
				reason: "stale_generation",
			});
			expect(qa.kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
			expect(await readFileOrUndefined(generationPaths(qa.paths, "confirmed").stopIntentFile)).toBeUndefined();
		},
	);

	it("rechecks a registration replaced while the host probe was in flight", async () => {
		const qa = await fixture();
		probes.protocol.mockImplementationOnce(async () => {
			await qa.register({ instanceId: "successor", generation: 8 });
			return undefined;
		});
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expectedGeneration }),
		).toEqual({ action: "refuse", reason: "stale_generation" });
		expect(qa.kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
	});

	it("signals the matching generation", async () => {
		const qa = await fixture();
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expectedGeneration }),
		).toEqual({ action: "stopped", pid: process.pid });
		expect(qa.kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
	});
});
