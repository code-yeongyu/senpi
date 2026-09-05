import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { expect, test } from "vitest";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";

// Regression: https://github.com/code-yeongyu/senpi/issues/1393
test("project trust reads the published snapshot while a writer lock is held", async () => {
	// Given a persisted trust decision and a real writer holding the store lock.
	const tempDir = mkdtempSync(join(tmpdir(), "senpi-project-trust-lock-"));
	const agentDir = join(tempDir, "agent");
	const projectDir = join(tempDir, "project");
	const store = new ProjectTrustStore(agentDir);
	store.set(projectDir, true);

	const writerEvents = new EventEmitter();
	const lockHeld = once(writerEvents, "lock-held");
	const releaseRequested = once(writerEvents, "release-requested");
	const writer = (async () => {
		const release = await lockfile.lock(agentDir, {
			realpath: false,
			lockfilePath: join(agentDir, "trust.json.lock"),
		});
		writerEvents.emit("lock-held");
		await releaseRequested;
		await release();
	})();

	await lockHeld;
	try {
		// When the reader loads trust during the writer's critical section.
		const decision = store.get(projectDir);

		// Then it sees the last atomically published snapshot without contending on the lock.
		expect(decision).toBe(true);
	} finally {
		writerEvents.emit("release-requested");
		await writer;
		rmSync(tempDir, { recursive: true, force: true });
	}
});
