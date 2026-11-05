import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchWin32ChildIdentity } from "../../../src/modes/rpc/host-lifecycle-drain.ts";
import * as processIdentity from "../../../src/utils/process-identity.ts";

// senpi#4684: the win32 supervisor re-read its host child's start time (a cold `powershell.exe
// Get-CimInstance` spawn) on every 500 ms tick for the host's whole life. A live pid's start time
// never changes, so it is read once; the tick is a free kill(pid, 0), and the start time is read
// again only when liveness says the pid may now belong to another process.
vi.mock("../../../src/utils/process-identity.ts", { spy: true });

const TICK_MS = 500;
const PID = 4_684_000;
const BOOT = "133000000000000000";
const STRANGER = "133000000099999999";

type Liveness = "alive" | "dead" | "denied";
let liveness: Liveness;
let startTime: string | undefined;
let readStartTime: ReturnType<typeof vi.mocked<typeof processIdentity.readProcessStartTime>>;

function errno(code: string): Error {
	return Object.assign(new Error(`kill ${code}`), { code });
}

beforeEach(() => {
	vi.useFakeTimers();
	liveness = "alive";
	startTime = BOOT;
	readStartTime = vi.mocked(processIdentity.readProcessStartTime);
	readStartTime.mockImplementation(async () => startTime);
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid !== PID || signal !== 0) throw new Error(`unexpected kill(${String(pid)}, ${String(signal)})`);
		if (liveness === "dead") throw errno("ESRCH");
		if (liveness === "denied") throw errno("EPERM");
		return true;
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

async function watch(): Promise<{ onGone: ReturnType<typeof vi.fn>; stop: () => void }> {
	const onGone = vi.fn();
	const child = { pid: PID, exitCode: null, signalCode: null };
	const stop = await watchWin32ChildIdentity(child, () => false, onGone);
	return { onGone, stop };
}

async function ticks(count: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(count * TICK_MS);
}

it("reads a live child's start time once, however many ticks pass", async () => {
	const { onGone, stop } = await watch();
	await ticks(40);
	stop();
	expect(readStartTime).toHaveBeenCalledTimes(1);
	expect(onGone).not.toHaveBeenCalled();
});

it("ends the watch when kill(pid, 0) reports the child gone on two ticks, with no start-time read", async () => {
	const { onGone, stop } = await watch();
	await ticks(5);
	liveness = "dead";
	startTime = undefined;
	await ticks(2);
	stop();
	expect(onGone).toHaveBeenCalledTimes(1);
	expect(readStartTime).toHaveBeenCalledTimes(1);
});

it("detects a pid that died and came back as another process by its start time", async () => {
	const { onGone, stop } = await watch();
	await ticks(5);
	liveness = "dead";
	startTime = undefined;
	await ticks(1);
	liveness = "alive";
	startTime = STRANGER;
	await ticks(1);
	stop();
	expect(onGone).toHaveBeenCalledTimes(1);
	expect(readStartTime).toHaveBeenCalledTimes(2);
});

it("keeps watching when a pid that looked gone for one tick still has the child's start time", async () => {
	const { onGone, stop } = await watch();
	liveness = "dead";
	await ticks(1);
	liveness = "alive";
	await ticks(40);
	stop();
	expect(onGone).not.toHaveBeenCalled();
	expect(readStartTime).toHaveBeenCalledTimes(2);
});

it("detects a pid now owned by another account (kill EPERM) by its start time", async () => {
	const { onGone, stop } = await watch();
	await ticks(3);
	liveness = "denied";
	startTime = STRANGER;
	await ticks(1);
	stop();
	expect(onGone).toHaveBeenCalledTimes(1);
	expect(readStartTime).toHaveBeenCalledTimes(2);
});

it("bounds start-time reads while liveness stays inconclusive", async () => {
	const { onGone, stop } = await watch();
	liveness = "denied";
	// 10 minutes of ticks: the reads back off to at most one a minute.
	await ticks(1_200);
	stop();
	expect(onGone).not.toHaveBeenCalled();
	expect(readStartTime.mock.calls.length).toBeLessThanOrEqual(1 + 5 + 10);
});

it("bounds start-time reads when the probe keeps failing, and never takes a failure for death", async () => {
	readStartTime.mockRejectedValue(new Error("Command failed: powershell.exe (timed out)"));
	const { onGone, stop } = await watch();
	await ticks(1_200);
	stop();
	expect(onGone).not.toHaveBeenCalled();
	expect(readStartTime.mock.calls.length).toBeLessThanOrEqual(1 + 5 + 10);
});

it("adopts a later start time when the first read failed, then stops reading", async () => {
	readStartTime.mockRejectedValueOnce(new Error("Command failed: powershell.exe (timed out)"));
	const { onGone, stop } = await watch();
	await ticks(1);
	expect(readStartTime).toHaveBeenCalledTimes(2);
	await ticks(200);
	expect(readStartTime).toHaveBeenCalledTimes(2);
	liveness = "denied";
	startTime = STRANGER;
	await ticks(1);
	stop();
	expect(onGone).toHaveBeenCalledTimes(1);
});
