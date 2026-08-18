import { spawn } from "node:child_process";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";

/** Long enough to keep the probe off the per-request path, short enough that a fresh `claude login` is picked up promptly. */
const AMBIENT_STATUS_TTL_MS = 30_000;

/**
 * `claude auth status` validates credentials, so it can stall on a hung network call. The probe sits
 * on the auth path of every request, and its result is shared, so one stall would otherwise park each
 * caller that joins it. Unavailable is the safe answer: the managed lanes still resolve.
 */
const AMBIENT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Memoises the probe, which spawns the Claude binary and costs a few hundred
 * milliseconds. Auth resolution runs per request, so an uncached probe would
 * put that on every model call. Concurrent readers share one in-flight probe;
 * a rejected probe is not cached.
 */
export function createAmbientAuthStatusReader(
	probe: () => Promise<boolean>,
	now: () => number = Date.now,
	ttlMs: number = AMBIENT_STATUS_TTL_MS,
): (signal?: AbortSignal) => Promise<boolean> {
	let cached: { at: number; value: boolean } | undefined;
	let inFlight: Promise<boolean> | undefined;
	const startProbe = (): Promise<boolean> => {
		const status = probe().then((value) => {
			cached = { at: now(), value };
			return value;
		});
		inFlight = status;
		const clear = () => {
			if (inFlight === status) inFlight = undefined;
		};
		void status.then(clear, clear);
		return status;
	};
	return (signal) => {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
		return untilAborted(inFlight ?? startProbe(), signal);
	};
}

/**
 * Stops THIS caller waiting once its request is abandoned, while the shared probe runs on for the
 * callers still waiting on it. Aborting the probe itself would cancel work another request owns.
 */
function untilAborted(status: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal === undefined) return status;
	if (signal.aborted) return Promise.reject(signal.reason);
	const abortController = new AbortController();
	const aborted = new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true, signal: abortController.signal });
	});
	return Promise.race([status, aborted]).finally(() => abortController.abort());
}

type ProbeChildProcess = {
	once(event: "error" | "close", listener: (code: number | null) => void): unknown;
	kill(signal: "SIGKILL"): unknown;
};

export type AmbientProbeOptions = {
	timeoutMs?: number;
	spawnProbe?: (command: string, args: readonly string[]) => ProbeChildProcess;
};

export async function probeAmbientClaudeAuthStatus(options: AmbientProbeOptions = {}): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? AMBIENT_PROBE_TIMEOUT_MS;
	const spawnProbe =
		options.spawnProbe ?? ((command, args) => spawn(command, [...args], { stdio: "ignore", windowsHide: true }));
	let executable: string;
	try {
		executable = resolveClaudeCodeExecutable(defaultExecutableDeps());
	} catch {
		return false;
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = (available: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			resolve(available);
		};
		const child = spawnProbe(executable, ["auth", "status"]);
		const deadline = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false);
		}, timeoutMs);
		deadline.unref?.();
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

export const readAmbientClaudeAuthStatus = createAmbientAuthStatusReader(probeAmbientClaudeAuthStatus);
