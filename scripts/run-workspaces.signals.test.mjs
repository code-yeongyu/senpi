#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createFixture,
	driverPath,
	THREE_WORKSPACES,
	WAITER_SOURCE,
	waitForClose,
	waitForFile,
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
			stdio: "ignore",
			env: { ...process.env, RUN_WORKSPACES_MARKER_FILE: fixture.markerFile },
		});
		try {
			await waitForFile(`${fixture.markerFile}.started`, 5_000);
			const scriptPid = Number(await readFile(`${fixture.markerFile}.started`, "utf8"));

			// When
			driver.kill("SIGTERM");
			const exit = await waitForClose(driver, 5_000);

			// Then
			await waitForFile(`${fixture.markerFile}.terminated`, 2_000);
			assert.equal(exit.signal, "SIGTERM", "the driver re-raises the signal after its child is gone");
			assert.ok(scriptPid > 0, "the fixture recorded the pid of the script that observed SIGTERM");
		} finally {
			driver.kill("SIGKILL");
			await fixture.dispose();
		}
	});

});
