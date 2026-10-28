import { constants, watch } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { startInProcessHost } from "./rpc-worker-host-support.ts";

/**
 * A stored `!command` credential is resolved while a session starts. On an in-process
 * host every session shares one event loop, so resolving it synchronously freezes every
 * other session for as long as the credential helper runs - a real broker can take
 * seconds. The credential command here announces its pid the moment it starts and then
 * blocks opening a FIFO that only this test writes, so it cannot finish on its own.
 *
 * The property is asserted by ordering, not by a latency budget (senpi#4638): the
 * concurrent `get_state` must answer while the helper is still running. A host that
 * waits for the helper cannot answer until the helper is gone - finished or killed by
 * the host's own command deadline - so the check fails however fast or loaded the
 * machine is.
 */
const MARKER_NAME = "credential-command-started";
const RELEASE_NAME = "credential-command-release";

const outcomeSchema = z.object({ success: z.boolean(), error: z.string().optional() });
const openedSchema = z.object({ success: z.literal(true), data: z.object({ sessionId: z.string() }) });

function sessionId(record: unknown): string {
	const outcome = outcomeSchema.parse(record);
	if (!outcome.success) throw new Error(`open_session failed: ${outcome.error}`);
	return openedSchema.parse(record).data.sessionId;
}

/**
 * Resolves when the credential command creates its marker. Subscribes before the
 * credential exists, so the start of the helper is observed, never polled for.
 */
function credentialCommandStarted(directory: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const watcher = watch(directory, (_event, filename) => {
			if (filename !== MARKER_NAME) return;
			clearTimeout(timer);
			watcher.close();
			// The helper renames a complete pid file into place, so the marker is never read half-written.
			resolve(readFile(join(directory, MARKER_NAME), "utf-8").then((pid) => Number.parseInt(pid, 10)));
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`the credential command never started in ${directory}`));
		}, 60_000);
	});
}

/**
 * Wakes a helper blocked on the release FIFO. The open never waits for a reader: with
 * nobody left on the other end (the helper finished, or the host's command deadline
 * killed it) it fails at once with ENXIO, and before the helper made the FIFO with ENOENT.
 */
async function releaseHelper(path: string): Promise<boolean> {
	try {
		const fifo = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
		try {
			await fifo.write("release\n");
		} finally {
			await fifo.close();
		}
		return true;
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code === "ENXIO" || code === "ENOENT") return false;
		throw cause;
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

it("keeps a concurrent session responsive while a !command credential is resolved", async () => {
	// Given a running host whose first session opened before any credential existed
	const host = await startInProcessHost();
	const release = join(host.agentDir, RELEASE_NAME);
	let helperPid: number | undefined;
	try {
		const observer = await host.connect();
		const observerSession = sessionId(await observer.request({ type: "open_session", cwd: host.cwd }));
		const started = credentialCommandStarted(host.agentDir);
		const marker = join(host.agentDir, MARKER_NAME);
		await writeFile(
			join(host.agentDir, "auth.json"),
			JSON.stringify({
				anthropic: {
					type: "api_key",
					// `$$` is the shell the host spawned for this command, the process its deadline kills.
					// It holds the FIFO open (fd 3) before publishing the marker, so from then on a
					// non-blocking release finds a reader for exactly as long as the helper lives.
					key: `!mkfifo '${release}' && exec 3<> '${release}' && echo $$ > '${marker}.tmp' && mv '${marker}.tmp' '${marker}' && read _ <&3 && echo resolved-secret`,
					env: { SENPI_CREDENTIAL_PROBE: "1" },
				},
			}),
		);

		// When another session opens and resolves that credential
		const probe = await host.connect();
		const probeOpen = probe.request({ type: "open_session", cwd: host.cwd }, 300_000);
		// Keep a failed measurement readable: the open is awaited below, this only stops the
		// teardown rejection from being reported as an unhandled error instead of the assertion.
		probeOpen.catch(() => {});
		helperPid = await started;
		const state = await observer.request({ type: "get_state", sessionId: observerSession }, 300_000);

		// Then the first session answers while the helper is still waiting for its release
		expect(outcomeSchema.parse(state).success).toBe(true);
		expect(isRunning(helperPid), "get_state answered only after the credential helper had exited").toBe(true);
		// and, once released, the probing session finishes opening. Whether the key resolved is
		// not observable here: no RPC response carries a resolved secret, and this offline host
		// lists no models either way, so this checks only that the open is not left waiting.
		expect(await releaseHelper(release), "the credential helper was gone before the test released it").toBe(true);
		expect(sessionId(await probeOpen)).not.toBe(observerSession);
	} finally {
		// A failure before the release must not strand the helper on a FIFO whose directory
		// dispose deletes: wake it, and kill it if it is still there.
		await releaseHelper(release);
		if (helperPid !== undefined && isRunning(helperPid)) process.kill(helperPid, "SIGKILL");
		await host.dispose();
	}
}, 600_000);
