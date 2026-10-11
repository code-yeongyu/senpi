import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { HostEnsureRefusedError } from "../../../src/modes/rpc/host-decision.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { generationEnv, generationScratch } from "../../helpers/rpc-generation-support.ts";

// #3054: a legacy drain cannot inherit the supervised child's 95-second circuit breaker.
describe.skipIf(process.platform === "win32")("legacy drain deadline", () => {
	it("refuses after its original ten seconds without killing a live legacy host", async () => {
		const qa = generationScratch("ld");
		const legacySocket = join(qa.agentDir, "rpc", "rpc.sock");
		await mkdir(dirname(legacySocket), { recursive: true });
		const child = spawn(
			process.execPath,
			[join(import.meta.dirname, "../../fixtures/rpc-legacy-drain-deadline.ts"), legacySocket],
			{
				env: { ...process.env, ...generationEnv(qa), SENPI_CODING_AGENT_DIR: qa.agentDir },
				stdio: ["ignore", "ignore", "inherit", "ipc"],
			},
		);
		const exited = once(child, "exit");
		try {
			const ready = once(child, "message", { signal: AbortSignal.timeout(10_000) });
			expect((await ready)[0]).toEqual({ type: "ready" });
			if (child.pid === undefined) throw new Error("legacy child missing pid");
			const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
			await mkdir(dirname(paths.legacyPidFile), { recursive: true });
			await writeFile(
				paths.legacyPidFile,
				JSON.stringify({
					pid: child.pid,
					processStartTime: await readProcessStartTime(child.pid),
				}),
			);
			const draining = once(child, "message", { signal: AbortSignal.timeout(10_000) });
			const timeout = globalThis.setTimeout;
			const cancelTimeout = globalThis.clearTimeout;
			let bound: ReturnType<typeof setTimeout> | undefined;
			vi.useFakeTimers();
			const result = ensureHost({ socket: qa.socket, agentDir: qa.agentDir }).catch((error: unknown) => error);
			try {
				expect((await draining)[0]).toEqual({ type: "drain" });
				await vi.advanceTimersByTimeAsync(10_051);
				const failure = await Promise.race([
					result,
					new Promise<never>((_resolve, reject) => {
						bound = timeout(() => reject(new Error("legacy refusal did not settle at ten seconds")), 5_000);
					}),
				]);
				expect(failure).toBeInstanceOf(HostEnsureRefusedError);
				expect((failure as HostEnsureRefusedError).reason).toBe("legacy_host");
				expect(child.exitCode).toBe(null);
				expect(child.signalCode).toBe(null);
			} finally {
				cancelTimeout(bound);
				// Drain a regressed 95-second deadline too, so a failing mutant releases its ensure lock.
				await vi.advanceTimersByTimeAsync(100_000);
				await result;
				vi.useRealTimers();
			}
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
			await rm(qa.root, { recursive: true, force: true });
		}
	});
});
