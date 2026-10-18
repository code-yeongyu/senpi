#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import {
	createFixture,
	driverPath,
	THREE_WORKSPACES,
	WAITER_SOURCE,
	waitForClose,
	waitForMarker,
	writeManifest,
} from "./run-workspaces.test-support.mjs";

describe("run-workspaces signals", () => {
	it("forwards a termination signal to the running workspace script instead of orphaning it", { skip: process.platform === "win32" }, async () => {
		// Given
		const fixture = await createFixture(THREE_WORKSPACES);
		const waiter = join(fixture.root, "wait.cjs");
		await writeFile(waiter, WAITER_SOURCE);
		await writeManifest(fixture.root, "packages/w", {
			name: "@fixture/w",
			version: "1.0.0",
			private: true,
			scripts: { wait: `node "${waiter.replaceAll("\\", "/")}"` },
		});
		const driver = spawn(process.execPath, [driverPath, "--workspace", "@fixture/w", "wait"], {
			cwd: fixture.root,
			stdio: ["ignore", "pipe", "inherit"],
			env: { ...process.env, RUN_WORKSPACES_MARKER_FILE: fixture.markerFile },
		});
		const lines = createInterface({ input: driver.stdout });
		try {
			const { pid: scriptPid } = await waitForMarker(lines, "started", 5_000);
			const terminated = waitForMarker(lines, "terminated", 2_000);
			const closed = waitForClose(driver, 5_000);
			const completed = Promise.all([terminated, closed]);

			// When
			driver.kill("SIGTERM");
			const [marker, exit] = await completed;

			// Then
			assert.equal(marker.pid, scriptPid, "the ready script observed SIGTERM");
			assert.equal(exit.signal, "SIGTERM", "the driver re-raises the signal after its child is gone");
			assert.ok(scriptPid > 0, "the fixture recorded the pid of the script that observed SIGTERM");
		} finally {
			lines.close();
			if (driver.exitCode === null && driver.signalCode === null) {
				const closed = waitForClose(driver, 5_000);
				driver.kill("SIGTERM");
				await closed;
			}
			await fixture.dispose();
		}
	});

});
