import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopSupervisor } from "./1370-supervisor-cleanup-support.ts";

// senpi#4703: the tree stop is cleanup's first step. These cases model one that did not stop the supervisor (a failed
// stop on win32), so only the fallback signals can end it and no assertion can be met by the tree stop alone.
vi.mock("../../../../senpi-codemode/src/kernels/js/process-tree-host.ts", () => ({
	terminateProcessTrees: async () => {},
}));

const spawned: ChildProcess[] = [];

/** An owned, detached fixture that survives SIGTERM, so only an escalated SIGKILL can end it. */
async function sigtermIgnoringSupervisor(): Promise<ChildProcess> {
	const script = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1 << 30);";
	const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	spawned.push(child);
	await once(child, "spawn");
	if (child.stdout === null) throw new Error("fixture stdout is not piped");
	await once(child.stdout, "data");
	return child;
}

/** Records the fallback signals sent to `child`, and makes the `failing` ones fail as an undeliverable signal would. */
function signalBoundary(child: ChildProcess, failing: readonly NodeJS.Signals[]): NodeJS.Signals[] {
	const sent: NodeJS.Signals[] = [];
	if (process.platform === "win32") {
		const kill = child.kill.bind(child);
		vi.spyOn(child, "kill").mockImplementation((signal) => {
			const name = signal as NodeJS.Signals;
			sent.push(name);
			return failing.includes(name) ? false : kill(name);
		});
		return sent;
	}
	const kill = process.kill.bind(process);
	vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid === -(child.pid ?? 0) && typeof signal === "string") {
			const name = signal as NodeJS.Signals;
			sent.push(name);
			if (failing.includes(name)) throw Object.assign(new Error(`EPERM: ${name} refused`), { code: "EPERM" });
		}
		return kill(pid, signal);
	});
	return sent;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const child of spawned.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

describe("stopSupervisor when the tree stop and a fallback signal fail (senpi#4703)", () => {
	it("escalates past a SIGTERM that could not be delivered and ends the supervisor with SIGKILL", async () => {
		const child = await sigtermIgnoringSupervisor();
		const sent = signalBoundary(child, ["SIGTERM"]);

		await expect(stopSupervisor(child, once(child, "exit"), () => "last line\n")).resolves.toBeUndefined();

		expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
		expect(child.signalCode).toBe("SIGKILL");
	}, 30_000);

	it("fails by name with the captured output and every signal failure when a rejected exit-wait leaves it running", async () => {
		const child = await sigtermIgnoringSupervisor();
		const sent = signalBoundary(child, ["SIGTERM", "SIGKILL"]);

		const failure: unknown = await stopSupervisor(
			child,
			Promise.reject(new Error("lost exit wait")),
			() => "supervisor said: last line\n",
		).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/supervisor did not exit within .* of cleanup/);
		expect((failure as Error).message).toContain("supervisor said: last line");
		expect((failure as Error).cause).toBeInstanceOf(AggregateError);
		expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
		expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
		expect(child.exitCode === null && child.signalCode === null).toBe(true);
	}, 30_000);

	it("returns without signalling when the spawn itself failed (no pid)", async () => {
		const never = spawn("senpi-4703-no-such-binary", []);
		const spawnFailed = once(never, "error");
		expect(never.pid).toBeUndefined();
		await expect(stopSupervisor(never, Promise.reject(new Error("spawn failed")), () => "")).resolves.toBeUndefined();
		await expect(spawnFailed).resolves.toBeDefined();
	}, 30_000);
});
