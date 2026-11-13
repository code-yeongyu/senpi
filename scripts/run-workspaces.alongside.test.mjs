#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectParallelism, MIN_PARALLELISM_FOR_SECOND_LANE } from "./run-workspaces-lanes.mjs";
import { parseArguments } from "./run-workspaces.mjs";
import { createFixture, driverPath, THREE_WORKSPACES, writeManifest } from "./run-workspaces.test-support.mjs";

// Each lane records start and end as files; `needs` names files that must already
// exist when the lane starts (ordering), `waitFor` a file it waits for (overlap).
// Both are observed through the file system, never through timing.
const LANE_SOURCE = `
const fs = require("node:fs");
const [, , dir, name, needs, waitFor] = process.argv;
if (needs !== "-" && !fs.existsSync(dir + "/" + needs)) { console.error(name + " started before " + needs); process.exit(8); }
fs.writeFileSync(dir + "/" + name + ".started", "");
const deadline = Date.now() + 5000;
while (waitFor !== "-" && !fs.existsSync(dir + "/" + waitFor)) {
	if (Date.now() > deadline) { console.error(name + " never saw " + waitFor); process.exit(7); }
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
fs.writeFileSync(dir + "/" + name + ".done", "");
`;

async function laneFixture(lanes) {
	const fixture = await createFixture({ workspaces: ["packages/*"], packages: {} });
	const dir = fixture.root.replaceAll("\\", "/");
	const lane = `${dir}/lane.cjs`;
	await writeFile(join(fixture.root, "lane.cjs"), LANE_SOURCE);
	for (const [name, needs, waitFor] of lanes) {
		await writeManifest(fixture.root, `packages/${name}`, {
			name: `@fixture/${name}`,
			version: "1.0.0",
			private: true,
			scripts: { test: `node "${lane}" "${dir}" ${name} ${needs} ${waitFor}` },
		});
	}
	return fixture;
}

function runWithParallelism(fixture, parallelism, args) {
	return spawnSync(process.execPath, [driverPath, ...args], {
		cwd: fixture.root,
		encoding: "utf8",
		env: { ...process.env, RUN_WORKSPACES_MARKER_FILE: fixture.markerFile, RUN_WORKSPACES_PARALLELISM: String(parallelism) },
	});
}

describe("run-workspaces --alongside", () => {
	it("parses --alongside once and refuses it together with --parallel", () => {
		assert.equal(parseArguments(["--alongside", "packages/x", "test"]).alongside, "packages/x");
		assert.equal(parseArguments(["test"]).alongside, undefined);
		assert.throws(() => parseArguments(["--alongside", "a", "--alongside", "b", "test"]), /once/);
		assert.throws(() => parseArguments(["--parallel", "--alongside", "a", "test"]), /cannot be combined/);
	});

	it("runs the alongside workspace next to the others, which keep their path order one at a time", async () => {
		// Given: z waits until a has started (overlap), b needs a finished (a and b do not overlap)
		const fixture = await laneFixture([
			["a", "-", "z.started"],
			["b", "a.done", "-"],
			["z", "-", "a.started"],
		]);
		try {
			// When
			const result = runWithParallelism(fixture, MIN_PARALLELISM_FOR_SECOND_LANE, ["--alongside", "packages/z", "test"]);

			// Then: a sequential run would time out inside a (exit 7)
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /packages\/z \(@fixture\/z\) runs alongside the other workspaces/);
			for (const name of ["a", "b", "z"]) assert.match(result.stdout, new RegExp(`PASS packages/${name} \\(@fixture/${name}\\)`));
		} finally {
			await fixture.dispose();
		}
	});

	it("stays fully sequential in path order below the second-lane minimum", async () => {
		// Given the recorder fixture: a and c define test, b does not
		const fixture = await createFixture(THREE_WORKSPACES);
		try {
			// When
			const result = runWithParallelism(fixture, MIN_PARALLELISM_FOR_SECOND_LANE - 1, [
				"--if-present",
				"--alongside",
				"packages/c",
				"test",
			]);

			// Then
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /sequential run: parallelism \d+ is below \d+/);
			const markers = await fixture.markers();
			assert.deepEqual(
				markers.map((marker) => marker.name),
				["@fixture/a", "@fixture/c"],
			);
			assert.match(result.stdout, /SKIP packages\/b \(@fixture\/b\)/);
		} finally {
			await fixture.dispose();
		}
	});

	it("runs a narrowed selection that leaves the alongside workspace out exactly as before", async () => {
		// Given
		const fixture = await createFixture(THREE_WORKSPACES);
		try {
			// When: the root test script carries --alongside and the caller narrows to one workspace
			const result = runWithParallelism(fixture, MIN_PARALLELISM_FOR_SECOND_LANE, [
				"--if-present",
				"--alongside",
				"packages/c",
				"test",
				"--workspace",
				"packages/a",
			]);

			// Then
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.deepEqual((await fixture.markers()).map((marker) => marker.name), ["@fixture/a"]);
			assert.doesNotMatch(result.stdout, /alongside the other workspaces|sequential run:/);
		} finally {
			await fixture.dispose();
		}
	});

	it("keeps every lane's result and exits with the first failing workspace's code", async () => {
		// Given a failing workspace in the sequential lane
		const fixture = await createFixture({
			workspaces: ["packages/*"],
			packages: {
				"packages/a": { name: "@fixture/a", scripts: { test: 4 } },
				"packages/b": { name: "@fixture/b", scripts: { test: 0 } },
				"packages/z": { name: "@fixture/z", scripts: { test: 0 } },
			},
		});
		try {
			// When
			const result = runWithParallelism(fixture, MIN_PARALLELISM_FOR_SECOND_LANE, ["--alongside", "packages/z", "test"]);

			// Then: b still ran after a failed
			assert.equal(result.status, 4, result.stdout + result.stderr);
			const markers = await fixture.markers();
			assert.deepEqual(markers.map((marker) => marker.name).sort(), ["@fixture/a", "@fixture/b", "@fixture/z"]);
			assert.match(result.stdout, /FAIL packages\/a \(@fixture\/a\) - exit 4/);
		} finally {
			await fixture.dispose();
		}
	});

	it("takes the parallelism override only as a positive integer", () => {
		assert.equal(detectParallelism({ RUN_WORKSPACES_PARALLELISM: "3" }, () => 64), 3);
		assert.equal(detectParallelism({}, () => 64), 64);
		assert.throws(() => detectParallelism({ RUN_WORKSPACES_PARALLELISM: "0" }), /positive integer/);
		assert.throws(() => detectParallelism({ RUN_WORKSPACES_PARALLELISM: "many" }), /positive integer/);
	});
});
