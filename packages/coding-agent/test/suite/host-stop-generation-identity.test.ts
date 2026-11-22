import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { type RegisteredHost, writeHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";
import { readFileOrUndefined } from "../../src/modes/rpc/host-daemon-state.ts";
import { runHostRequest } from "../../src/modes/rpc/host-runner.ts";
import { stopHost } from "../../src/modes/rpc/host-stop.ts";
import { parseHostStopGeneration } from "../../src/modes/rpc/host-stop-generation.ts";
import { readProcessStartTime } from "../../src/utils/process-identity.ts";

const probes = vi.hoisted(() => ({
	protocol: vi.fn(),
	sessions: vi.fn(),
	counts: vi.fn(),
	unreadable: vi.fn(),
	beforeRead: [] as Array<() => Promise<void>>,
	/** Simulated Windows CIM answer for the stop-time probe: a FILETIME string, "gone", or unset (real probe). */
	liveStart: undefined as string | undefined,
}));
vi.mock("../../src/modes/rpc/host-daemon-registration.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../src/modes/rpc/host-daemon-registration.ts")>();
	return {
		...real,
		readHostRegistration: async (...args: Parameters<typeof real.readHostRegistration>) => {
			await probes.beforeRead.shift()?.();
			return real.readHostRegistration(...args);
		},
	};
});
vi.mock("../../src/modes/rpc/host-stop-start-time.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/modes/rpc/host-stop-start-time.ts")>()),
	processStartTimeIsUnreadable: probes.unreadable,
}));
vi.mock("../../src/utils/process-identity.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../src/utils/process-identity.ts")>();
	return {
		...real,
		readProcessStartTime: (...args: Parameters<typeof real.readProcessStartTime>) => {
			if (probes.liveStart === "gone") return Promise.resolve(undefined);
			if (probes.liveStart !== undefined) return Promise.resolve(probes.liveStart);
			return real.readProcessStartTime(...args);
		},
	};
});
vi.mock("../../src/modes/rpc/host-probe.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/modes/rpc/host-probe.ts")>()),
	probeProtocolInfo: probes.protocol,
	probeSessionCount: probes.sessions,
}));
vi.mock("../../src/modes/rpc/host-status.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/modes/rpc/host-status.ts")>()),
	readSessionCounts: probes.counts,
}));

const IDLE = { total: 0, interactive: 0, worker: 0, retained: 0, foreign_attached: 0, foreign_retained: 0 };
const OCCUPIED = { ...IDLE, total: 1, interactive: 1, foreign_attached: 1 };

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "stop-identity-"));
	probes.protocol.mockReset().mockResolvedValue(undefined);
	probes.sessions.mockReset().mockResolvedValue(undefined);
	probes.counts.mockReset().mockResolvedValue(IDLE);
	probes.unreadable.mockReset().mockReturnValue(false);
	probes.beforeRead.length = 0;
	probes.liveStart = undefined;
});
const children: ChildProcess[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

async function fixture(recorded: string | null) {
	const socket = join(root, "r.sock");
	const paths = createHostDaemonPaths({ socket, agentDir: root });
	const register = (change: Partial<RegisteredHost> = {}) =>
		writeHostRegistration(paths, {
			socket,
			instanceId: "confirmed",
			generation: 7,
			record: { pid: process.pid, processStartTime: recorded },
			launchProfileId: "test",
			...change,
		});
	await register();
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	const signals = () => kill.mock.calls.filter(([, signal]) => signal !== 0);
	const intent = () => readFileOrUndefined(generationPaths(paths, "confirmed").stopIntentFile);
	const expected = (processStartTime: string | null) => ({
		instanceId: "confirmed",
		generation: 7,
		pid: process.pid,
		processStartTime,
	});
	return { socket, signals, intent, expected, register };
}

// desktop#3561 review: on Windows every engine host records processStartTime = null (measured on a Windows runner).
describe("binding a stop when the process start time is unreadable", () => {
	it("on Windows binds pid + instance + generation and signals exactly the confirmed pid", async () => {
		probes.unreadable.mockReturnValue(true);
		probes.liveStart = windowsFileTime(Date.now() - 60_000);
		const qa = await fixture(null);
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expected(null) }),
		).toEqual({ action: "stopped", pid: process.pid });
		expect(qa.signals()).toEqual([[process.pid, "SIGTERM"]]);
		expect(JSON.parse((await qa.intent()) ?? "{}")).toMatchObject({
			targetPid: process.pid,
			reason: "operator_stop",
		});
	});

	it("on Windows refuses a reused pid: the live process started after the registration was written", async () => {
		probes.unreadable.mockReturnValue(true);
		const qa = await fixture(null);
		probes.liveStart = windowsFileTime(Date.now() + 60_000);
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expected(null) }),
		).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(qa.signals()).toEqual([]);
		expect(await qa.intent()).toBeUndefined();
	});

	it("on Windows refuses a confirmed pid whose process is gone", async () => {
		probes.unreadable.mockReturnValue(true);
		const qa = await fixture(null);
		probes.liveStart = "gone";
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expected(null) }),
		).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(qa.signals()).toEqual([]);
	});

	it("on Windows refuses when the answering host is another instance", async () => {
		probes.unreadable.mockReturnValue(true);
		probes.liveStart = windowsFileTime(Date.now() - 60_000);
		const qa = await fixture(null);
		probes.protocol.mockResolvedValue({ instanceId: "successor" });
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expected(null) }),
		).toEqual({ action: "refuse", reason: "stale_generation" });
		expect(qa.signals()).toEqual([]);
	});

	it("off Windows refuses an unprovable identity as unknown_owner, not stale_generation", async () => {
		probes.unreadable.mockReturnValue(false);
		const qa = await fixture(null);
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expected(null) }),
		).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(qa.signals()).toEqual([]);
		expect(await qa.intent()).toBeUndefined();
	});

	it.each([
		["the registration lost its start time", null, "start-1"],
		["the confirmation carries none", "start-1", null],
	] as const)("refuses as unknown_owner when %s", async (_case, recorded, confirmed) => {
		probes.unreadable.mockReturnValue(true);
		const qa = await fixture(recorded);
		expect(
			await stopHost({ socket: qa.socket, agentDir: root, force: true, expectedGeneration: qa.expected(confirmed) }),
		).toEqual({ action: "refuse", reason: "unknown_owner" });
		expect(qa.signals()).toEqual([]);
	});

	it("parses an explicit null start time but not a missing one", () => {
		const base = { instanceId: "confirmed", generation: 7, pid: 42 };
		expect(parseHostStopGeneration(JSON.stringify({ ...base, processStartTime: null }))).toEqual({
			...base,
			processStartTime: null,
		});
		expect(parseHostStopGeneration(JSON.stringify(base))).toBeUndefined();
	});
});

describe("generation-bound stop requests", () => {
	it("rejects drain combined with an expected generation before touching the host", async () => {
		const qa = await fixture("start-1");
		await expect(
			stopHost({ socket: qa.socket, agentDir: root, drain: true, expectedGeneration: qa.expected("start-1") }),
		).rejects.toThrow(/expectedGeneration/);
		expect(qa.signals()).toEqual([]);
		expect(probes.protocol).not.toHaveBeenCalled();
	});

	it("reports stale_generation before sessions_live for a changed binding on an occupied host", async () => {
		const qa = await fixture("start-1");
		probes.counts.mockResolvedValue(OCCUPIED);
		const outcome = await runHostRequest({
			action: "stop",
			target: { socket: qa.socket, agentDir: root },
			drain: false,
			force: false,
			expectedGeneration: { ...qa.expected("start-1"), generation: 6 },
		});
		expect(outcome.payload).toMatchObject({ action: "refuse", reason: "stale_generation" });
		expect(qa.signals()).toEqual([]);
	});

	it("still refuses sessions_live for a current binding on an occupied host without force", async () => {
		const qa = await fixture("start-1");
		probes.counts.mockResolvedValue(OCCUPIED);
		const outcome = await runHostRequest({
			action: "stop",
			target: { socket: qa.socket, agentDir: root },
			drain: false,
			force: false,
			expectedGeneration: qa.expected("start-1"),
		});
		expect(outcome.payload).toMatchObject({ action: "refuse", reason: "sessions_live" });
		expect(qa.signals()).toEqual([]);
	});
});

/** A live second process whose start time is provable, so a registration naming it passes the owner proof. */
async function provableStranger(): Promise<{ readonly pid: number; readonly processStartTime: string }> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	const pid = child.pid;
	if (pid === undefined) throw new Error("stranger did not start");
	const processStartTime = await readProcessStartTime(pid);
	if (processStartTime === undefined) throw new Error("stranger start time unreadable");
	return { pid, processStartTime };
}

// #3805 review LOW: the signal target must be the RECHECKED confirmed generation, never a registration read in between.
describe("the signal target of a generation-bound stop", () => {
	it("never signals a registration swapped in after the first compare and swapped back by the probe", async () => {
		const start = await readProcessStartTime(process.pid);
		if (start === undefined) throw new Error("fixture process identity unavailable");
		const qa = await fixture(start);
		const stranger = await provableStranger();
		probes.beforeRead.push(
			async () => {},
			() => qa.register({ record: stranger }),
		);
		probes.protocol.mockImplementationOnce(async () => {
			await qa.register();
			return undefined;
		});
		const result = await stopHost({
			socket: qa.socket,
			agentDir: root,
			force: true,
			expectedGeneration: qa.expected(start),
		});
		expect(qa.signals()).toEqual([]);
		expect(result).toEqual({ action: "refuse", reason: "stale_generation" });
	});
});

/** A Windows CIM `CreationDate.ToFileTimeUtc()` value for `ms`. */
function windowsFileTime(ms: number): string {
	return (BigInt(Math.trunc(ms)) * 10_000n + 116_444_736_000_000_000n).toString();
}
