#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArguments, resolveWorkspaceDirectories } from "./run-workspaces.mjs";
import { createFixture, runDriver, THREE_WORKSPACES } from "./run-workspaces.test-support.mjs";

describe("run-workspaces", () => {
	it("runs the script once in every workspace that defines it and never re-enters the root", async () => {
		// Given
		const fixture = await createFixture(THREE_WORKSPACES);
		try {
			// When
			const result = runDriver(fixture, ["--if-present", "test"]);

			// Then
			assert.equal(result.status, 0, result.stdout + result.stderr);
			const markers = await fixture.markers();
			assert.deepEqual(
				markers.map((marker) => marker.name),
				["@fixture/a", "@fixture/c"],
				"each present script runs exactly once, in path order, and the root script is never re-entered",
			);
			assert.deepEqual(
				markers.map((marker) => marker.cwd),
				[join(fixture.root, "packages/a"), join(fixture.root, "packages/c")],
			);
			assert.match(result.stdout, /PASS packages\/a \(@fixture\/a\)/);
			assert.match(result.stdout, /SKIP packages\/b \(@fixture\/b\)/);
			assert.match(result.stdout, /PASS packages\/c \(@fixture\/c\)/);
		} finally {
			await fixture.dispose();
		}
	});

	it("keeps running after a failure and exits with the first failing workspace's code", async () => {
		// Given
		const fixture = await createFixture({
			workspaces: ["packages/*"],
			packages: {
				"packages/a": { name: "@fixture/a", scripts: { test: 0 } },
				"packages/b": { name: "@fixture/b", scripts: { test: 3 } },
				"packages/c": { name: "@fixture/c", scripts: { test: 5 } },
				"packages/d": { name: "@fixture/d", scripts: { test: 0 } },
			},
		});
		try {
			// When
			const result = runDriver(fixture, ["test"]);

			// Then
			assert.equal(result.status, 3, result.stdout + result.stderr);
			const markers = await fixture.markers();
			assert.deepEqual(
				markers.map((marker) => marker.name),
				["@fixture/a", "@fixture/b", "@fixture/c", "@fixture/d"],
				"a failure must not stop the remaining workspaces",
			);
			assert.match(result.stdout, /FAIL packages\/b \(@fixture\/b\) .*exit 3/);
			assert.match(result.stdout, /FAIL packages\/c \(@fixture\/c\) .*exit 5/);
			assert.match(result.stdout, /PASS packages\/d \(@fixture\/d\)/);
		} finally {
			await fixture.dispose();
		}
	});

	it("targets a single workspace by name or by path and forwards arguments after --", async () => {
		// Given
		const fixture = await createFixture(THREE_WORKSPACES);
		try {
			// When
			const byName = runDriver(fixture, ["--workspace", "@fixture/c", "test", "--", "--grep", "smoke test"]);
			const byPath = runDriver(fixture, ["test", "--workspace", "packages/a", "--", "--reporter=dot"]);

			// Then
			assert.equal(byName.status, 0, byName.stdout + byName.stderr);
			assert.equal(byPath.status, 0, byPath.stdout + byPath.stderr);
			assert.deepEqual(await fixture.markers(), [
				{ name: "@fixture/c", cwd: join(fixture.root, "packages/c"), forwarded: ["--grep", "smoke test"] },
				{ name: "@fixture/a", cwd: join(fixture.root, "packages/a"), forwarded: ["--reporter=dot"] },
			]);
		} finally {
			await fixture.dispose();
		}
	});

	it("fails when a selected workspace lacks the script unless --if-present is set", async () => {
		// Given
		const fixture = await createFixture(THREE_WORKSPACES);
		try {
			// When
			const strict = runDriver(fixture, ["test"]);
			const lenient = runDriver(fixture, ["--if-present", "--workspace", "@fixture/b", "test"]);

			// Then
			assert.equal(strict.status, 1, strict.stdout + strict.stderr);
			assert.match(strict.stderr, /packages\/b \(@fixture\/b\).*no "test" script/);
			assert.equal(lenient.status, 0, lenient.stdout + lenient.stderr);
			assert.deepEqual(await fixture.markers(), [], "a strict run must not start any workspace before reporting");
		} finally {
			await fixture.dispose();
		}
	});

	it("rejects an unknown workspace selector and a missing script name as usage errors", async () => {
		// Given
		const fixture = await createFixture(THREE_WORKSPACES);
		try {
			// When
			const unknownWorkspace = runDriver(fixture, ["--workspace", "@fixture/nope", "test"]);
			const noScript = runDriver(fixture, ["--if-present"]);
			const unknownFlag = runDriver(fixture, ["--parallel", "test"]);

			// Then
			assert.equal(unknownWorkspace.status, 2);
			assert.match(unknownWorkspace.stderr, /unknown workspace "@fixture\/nope"/);
			assert.equal(noScript.status, 2);
			assert.match(noScript.stderr, /script name is required/);
			assert.equal(unknownFlag.status, 2);
			assert.match(unknownFlag.stderr, /unknown argument: --parallel/);
			assert.deepEqual(await fixture.markers(), []);
		} finally {
			await fixture.dispose();
		}
	});

	it("resolves nested workspace globs and explicit paths in deterministic path order", async () => {
		// Given
		const fixture = await createFixture({
			workspaces: ["packages/*", "packages/nested/*", "tools/explicit", "packages/missing/*"],
			packages: {
				"packages/zeta": { name: "@fixture/zeta", scripts: { test: 0 } },
				"packages/alpha": { name: "@fixture/alpha", scripts: { test: 0 } },
				"packages/nested/inner": { name: "@fixture/inner", scripts: { test: 0 } },
				"tools/explicit": { name: "@fixture/explicit", scripts: { test: 0 } },
			},
		});
		try {
			await mkdir(join(fixture.root, "packages/no-manifest"), { recursive: true });

			// When
			const directories = await resolveWorkspaceDirectories(fixture.root);

			// Then
			assert.deepEqual(
				directories.map((workspace) => [workspace.relativePath, workspace.name]),
				[
					["packages/alpha", "@fixture/alpha"],
					["packages/nested/inner", "@fixture/inner"],
					["packages/zeta", "@fixture/zeta"],
					["tools/explicit", "@fixture/explicit"],
				],
			);
		} finally {
			await fixture.dispose();
		}
	});

	it("parses options on either side of the script name and stops at --", () => {
		// When
		const parsed = parseArguments(["--if-present", "test", "--workspace", "packages/a", "--", "--if-present", "x"]);

		// Then
		assert.deepEqual(parsed, {
			script: "test",
			ifPresent: true,
			workspaces: ["packages/a"],
			forwarded: ["--if-present", "x"],
		});
	});
});
