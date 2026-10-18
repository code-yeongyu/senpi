import { watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { startInProcessHost } from "./rpc-worker-host-support.ts";

/**
 * A stored `!command` credential is resolved while a session starts. On an in-process
 * host every session shares one event loop, so resolving it synchronously freezes every
 * other session for as long as the credential helper runs - a real broker can take
 * seconds. The credential command here announces itself the moment it starts and then
 * holds a shell open, so the concurrent measurement happens while it is provably running.
 */
const CREDENTIAL_COMMAND_SECONDS = 3;

/** A routed command on an unrelated session must stay interactive while the helper runs. */
const CONCURRENT_COMMAND_BUDGET_MS = 50;

const MARKER_NAME = "credential-command-started";

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
			if (filename !== MARKER_NAME) return;
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

it("keeps a concurrent session responsive while a !command credential is resolved", async () => {
	// Given a running host whose first session opened before any credential existed
	const host = await startInProcessHost();
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
					key: `!sh -c 'touch ${marker}; sleep ${CREDENTIAL_COMMAND_SECONDS}; echo resolved-secret'`,
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

		// Then the first session answers while the helper is still running
		expect(outcomeSchema.parse(state).success).toBe(true);
		process.stderr.write(`concurrent get_state during a !command credential read: ${elapsedMs.toFixed(0)}ms\n`);
		expect(elapsedMs).toBeLessThan(CONCURRENT_COMMAND_BUDGET_MS);
		// and the credential still resolves through its own command
		expect(sessionId(await probeOpen)).not.toBe(observerSession);
	} finally {
		await host.dispose();
	}
}, 600_000);
