#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { parseArguments } from "./run-workspaces.mjs";
import {
	createFixture,
	driverPath,
	runDriver,
	THREE_WORKSPACES,
	WAITER_SOURCE,
	waitForClose,
	writeManifest,
} from "./run-workspaces.test-support.mjs";

// A lane that announces itself, then waits for a sibling's announcement file
// before finishing: overlap is observed through files, never through timing.
const RENDEZVOUS_SOURCE = `
const fs = require("node:fs");
const [, , dir, name, peer] = process.argv;
fs.writeFileSync(dir + "/" + name + ".started", String(Date.now()));
const deadline = Date.now() + 5000;
while (!fs.existsSync(dir + "/" + peer + ".started")) {
	if (Date.now() > deadline) { console.error(name + " never saw " + peer); process.exit(7); }
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
console.log(name + " saw " + peer);
process.exit(0);
`;

async function twoLaneFixture() {
	const fixture = await createFixture({ workspaces: ["packages/*"], packages: {} });
	const lane = join(fixture.root, "lane.cjs").replaceAll("\\", "/");
	const dir = fixture.root.replaceAll("\\", "/");
	await writeFile(join(fixture.root, "lane.cjs"), RENDEZVOUS_SOURCE);
	for (const [name, peer] of [
		["ai", "coding-agent"],
		["coding-agent", "ai"],
	]) {
		await writeManifest(fixture.root, `packages/${name}`, {
			name: `@fixture/${name}`,
			version: "1.0.0",
			private: true,
			scripts: { dev: `node "${lane}" "${dir}" ${name} ${peer}` },
		});
	}
	return fixture;
}

describe("run-workspaces --parallel", () => {
	it("parses --parallel on either side of the script name", () => {
		assert.equal(parseArguments(["--parallel", "--workspace", "a", "dev"]).parallel, true);
		assert.equal(parseArguments(["dev", "--parallel"]).parallel, true);
		assert.equal(parseArguments(["dev"]).parallel, false);
	});

	it("runs the selected workspaces at the same time and prefixes every line with the workspace directory", async () => {
		// Given two lanes that each block until the other has started
		const fixture = await twoLaneFixture();
		try {
			// When
			const result = runDriver(fixture, [
				"--parallel",
				"--workspace",
				"@fixture/ai",
				"--workspace",
				"@fixture/coding-agent",
				"dev",
			]);

			// Then: sequential execution would time out inside the first lane (exit 7)
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /^\[ai\] ai saw coding-agent$/m);
			assert.match(result.stdout, /^\[coding-agent\] coding-agent saw ai$/m);
			assert.match(result.stdout, /PASS packages\/ai \(@fixture\/ai\)/);
			assert.match(result.stdout, /PASS packages\/coding-agent \(@fixture\/coding-agent\)/);
		} finally {
			await fixture.dispose();
		}
	});

	it("lets the surviving lane finish and exits with the failing lane's code", async () => {
		// Given
		const fixture = await createFixture({
			workspaces: ["packages/*"],
			packages: {
				"packages/a": { name: "@fixture/a", scripts: { dev: 3 } },
				"packages/b": { name: "@fixture/b", scripts: { dev: 0 } },
			},
		});
		try {
			// When
			const result = runDriver(fixture, ["--parallel", "dev"]);

			// Then
			assert.equal(result.status, 3, result.stdout + result.stderr);
			const markers = await fixture.markers();
			assert.deepEqual(markers.map((marker) => marker.name).sort(), ["@fixture/a", "@fixture/b"]);
			assert.match(result.stdout, /FAIL packages\/a \(@fixture\/a\) - exit 3/);
			assert.match(result.stdout, /PASS packages\/b \(@fixture\/b\)/);
		} finally {
			await fixture.dispose();
		}
	});

	it("forwards one termination signal to every lane and re-raises it after all lanes closed", { skip: process.platform === "win32" }, async () => {
		// Given two waiting lanes
		const fixture = await createFixture(THREE_WORKSPACES);
		const waiter = join(fixture.root, "wait.cjs").replaceAll("\\", "/");
		await writeFile(join(fixture.root, "wait.cjs"), WAITER_SOURCE);
		for (const name of ["x", "y"]) {
			await writeManifest(fixture.root, `packages/${name}`, {
				name: `@fixture/${name}`,
				version: "1.0.0",
				private: true,
				scripts: { wait: `node "${waiter}"` },
			});
		}
		const driver = spawn(process.execPath, [driverPath, "--parallel", "--workspace", "@fixture/x", "--workspace", "@fixture/y", "wait"], {
			cwd: fixture.root,
			stdio: ["ignore", "pipe", "inherit"],
			env: { ...process.env, RUN_WORKSPACES_MARKER_FILE: fixture.markerFile },
		});
		const lines = createInterface({ input: driver.stdout });
		// Lane output is prefixed `[x] `; strip the tag before parsing the JSON marker.
		// One listener collects every marker; waiters poll the collected list.
		const markers = [];
		const waiters = new Set();
		lines.on("line", (line) => {
			const json = line.replace(/^\[[^\]]+\] /, "");
			if (!json.startsWith('{"event":')) return;
			markers.push(JSON.parse(json));
			for (const waiter of waiters) waiter();
		});
		const seen = (event, count, timeoutMs) =>
			new Promise((resolvePromise, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`timed out waiting for ${count} ${event} marker(s)`));
				}, timeoutMs);
				function check() {
					const matching = markers.filter((marker) => marker.event === event);
					if (matching.length >= count) {
						clearTimeout(timer);
						waiters.delete(check);
						resolvePromise(matching);
					}
				}
				waiters.add(check);
				check();
			});
		try {
			const started = await seen("started", 2, 5_000);
			const terminated = seen("terminated", 2, 3_000);
			const closed = waitForClose(driver, 5_000);

			// When
			driver.kill("SIGTERM");
			const [ended, exit] = await Promise.all([terminated, closed]);

			// Then
			assert.deepEqual(
				ended.map((marker) => marker.pid).sort(),
				started.map((marker) => marker.pid).sort(),
				"both waiting lanes observed SIGTERM",
			);
			assert.equal(exit.signal, "SIGTERM", "the driver re-raises the signal once every lane is gone");
		} finally {
			lines.close();
			if (driver.exitCode === null && driver.signalCode === null) {
				const closedLate = waitForClose(driver, 5_000);
				driver.kill("SIGTERM");
				await closedLate;
			}
			await fixture.dispose();
		}
	});
});
