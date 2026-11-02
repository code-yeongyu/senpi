import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { startInProcessHost } from "./rpc-worker-host-support.ts";

/**
 * A stored `!command` credential is resolved while a session starts. On an in-process
 * host every session shares one event loop, so resolving it synchronously freezes every
 * other session for as long as the credential helper runs - a real broker can take
 * seconds. The property under test is an ordering, not a latency: the unrelated session
 * is answered *while the helper is provably still running*. The helper therefore cannot
 * finish on its own - it blocks on a release this test controls - so a host that resolves
 * the credential synchronously cannot answer `get_state` at all until the test releases it.
 *
 * Wall-clock budgets were tried here and only measured the host's scheduler: on a loaded
 * machine a perfectly non-blocking answer still lands tens of milliseconds late.
 */

/** The helper's own deadline, so a regression cannot wedge the in-process host forever. */
const CREDENTIAL_RELEASE_TIMEOUT_SECONDS = 30;

const STARTED_MARKER_NAME = "credential-command-started";
const FINISHED_MARKER_NAME = "credential-command-finished";
const RELEASE_FIFO_NAME = "credential-command-release";
const CLAIM_DIRECTORY_NAME = "credential-command-claim";
const HELPER_SCRIPT_NAME = "credential-command.sh";

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
function credentialCommandStarted(directory: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const watcher = watch(directory, (_event, filename) => {
			if (filename !== STARTED_MARKER_NAME) return;
			clearTimeout(timer);
			watcher.close();
			resolve();
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`the credential command never started in ${directory}`));
		}, 60_000);
	});
}

/**
 * `bash` explicitly, not `sh`: the wait needs `read -t`, which dash does not have. The FIFO
 * is opened read-write so the helper's own open never blocks on a reader, and the bounded
 * read means a test that dies before releasing still lets the helper exit. Only the first
 * invocation waits - `mkdir` claims that role atomically - so the further resolutions a
 * session start makes answer immediately; one helper caught mid-flight is the whole property.
 */
function helperScript(
	startedMarker: string,
	finishedMarker: string,
	releaseFifo: string,
	claimDirectory: string,
): string {
	return [
		"#!/usr/bin/env bash",
		`if mkdir '${claimDirectory}' 2>/dev/null; then`,
		`	mkfifo '${releaseFifo}' 2>/dev/null || true`,
		`	exec 3<> '${releaseFifo}'`,
		`	: > '${startedMarker}'`,
		`	read -r -t ${CREDENTIAL_RELEASE_TIMEOUT_SECONDS} -u 3 _release || true`,
		`	: > '${finishedMarker}'`,
		"fi",
		"echo resolved-secret",
		"",
	].join("\n");
}

it("keeps a concurrent session responsive while a !command credential is resolved", async () => {
	// Given a running host whose first session opened before any credential existed
	const host = await startInProcessHost();
	try {
		const observer = await host.connect();
		const observerSession = sessionId(await observer.request({ type: "open_session", cwd: host.cwd }));
		const started = credentialCommandStarted(host.agentDir);
		const startedMarker = join(host.agentDir, STARTED_MARKER_NAME);
		const finishedMarker = join(host.agentDir, FINISHED_MARKER_NAME);
		const releaseFifo = join(host.agentDir, RELEASE_FIFO_NAME);
		const helperPath = join(host.agentDir, HELPER_SCRIPT_NAME);
		const claimDirectory = join(host.agentDir, CLAIM_DIRECTORY_NAME);
		await writeFile(helperPath, helperScript(startedMarker, finishedMarker, releaseFifo, claimDirectory));
		await writeFile(
			join(host.agentDir, "auth.json"),
			JSON.stringify({
				anthropic: {
					type: "api_key",
					key: `!bash '${helperPath}'`,
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
		await started;
		const startedAt = performance.now();
		const state = await observer.request({ type: "get_state", sessionId: observerSession }, 300_000);
		const elapsedMs = performance.now() - startedAt;
		const helperFinished = existsSync(finishedMarker);

		// Then the first session answered while the helper was still running
		expect(outcomeSchema.parse(state).success).toBe(true);
		process.stderr.write(`concurrent get_state during a !command credential read: ${elapsedMs.toFixed(0)}ms\n`);
		expect(helperFinished).toBe(false);

		// and the credential still resolves through its own command once it is released
		await writeFile(releaseFifo, "release\n");
		expect(sessionId(await probeOpen)).not.toBe(observerSession);
	} finally {
		await host.dispose();
	}
}, 600_000);
