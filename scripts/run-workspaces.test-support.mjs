#!/usr/bin/env node
// Shared fixture for the run-workspaces tests: a temp workspace whose package
// scripts append one JSON line per invocation, so a re-entered root or a doubled
// workspace shows up as data rather than as a timing artifact.
import { spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const driverPath = fileURLToPath(new URL("./run-workspaces.mjs", import.meta.url));

const RECORDER_SOURCE = `
const fs = require("node:fs");
const [, , name, exitCode = "0", ...forwarded] = process.argv;
fs.appendFileSync(process.env.RUN_WORKSPACES_MARKER_FILE, JSON.stringify({ name, cwd: process.cwd(), forwarded }) + "\\n");
process.exit(Number(exitCode));
`;

// A long-running fixture script: records its pid once running, then waits until
// SIGTERM arrives and records that too. Ten seconds is only the safety net for a
// driver that never forwards the signal. The pid marker is written to a temp
// name and renamed into place: a directory watcher fires on creation, before
// writeFileSync has written the content, and a reader that raced it saw an
// empty file (CI, 'Script tests (bun)', 2026-09-07). rename is atomic, so the
// marker never exists without its content.
export const WAITER_SOURCE = `
const fs = require("node:fs");
const marker = process.env.RUN_WORKSPACES_MARKER_FILE;
fs.writeFileSync(marker + ".started.tmp", String(process.pid));
fs.renameSync(marker + ".started.tmp", marker + ".started");
process.on("SIGTERM", () => { fs.writeFileSync(marker + ".terminated", ""); process.exit(0); });
setTimeout(() => process.exit(9), 10_000);
`;

export const THREE_WORKSPACES = {
	workspaces: ["packages/*"],
	packages: {
		"packages/a": { name: "@fixture/a", scripts: { test: 0, clean: 0 } },
		"packages/b": { name: "@fixture/b", scripts: { clean: 0 } },
		"packages/c": { name: "@fixture/c", scripts: { test: 0 } },
	},
};

export async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

export async function createFixture({ workspaces, packages, rootScripts = {} }) {
	// realpath: macOS hands out /var/folders/... while children observe /private/var/...
	const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-run-workspaces-")));
	const recorder = join(root, "record.cjs").replaceAll("\\", "/");
	await writeFile(join(root, "record.cjs"), RECORDER_SOURCE);
	const script = (name, exitCode = 0) => `node "${recorder}" ${name} ${exitCode}`;
	await writeManifest(root, ".", {
		name: "fixture-root",
		private: true,
		workspaces,
		scripts: { test: script("ROOT"), ...rootScripts },
	});
	for (const [relativeDirectory, { name, scripts }] of Object.entries(packages)) {
		await writeManifest(root, relativeDirectory, {
			name,
			version: "1.0.0",
			private: true,
			scripts: Object.fromEntries(
				Object.entries(scripts ?? {}).map(([scriptName, exitCode]) => [scriptName, script(name, exitCode)]),
			),
		});
	}
	const markerFile = join(root, "markers.jsonl");
	return {
		root,
		markerFile,
		async markers() {
			const content = await readFile(markerFile, "utf8").catch(() => "");
			return content
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
		async dispose() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

// The driver is spawned with this test process's environment, so it runs under
// whichever package manager launched the test run: bun via `bun run test:scripts`,
// npm via `npm run test:scripts`, plain node when invoked directly. That is the
// contract under test: the same manifest must behave identically everywhere.
export function runDriver(fixture, args) {
	return spawnSync(process.execPath, [driverPath, ...args], {
		cwd: fixture.root,
		encoding: "utf8",
		env: { ...process.env, RUN_WORKSPACES_MARKER_FILE: fixture.markerFile },
	});
}

export function waitForFile(path, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const watcher = watch(dirname(path), () => {
			if (!existsSync(path)) return;
			finish();
			resolvePromise();
		});
		const timer = setTimeout(() => {
			finish();
			reject(new Error(`timed out waiting for ${path}`));
		}, timeoutMs);
		function finish() {
			clearTimeout(timer);
			watcher.close();
		}
		if (existsSync(path)) {
			finish();
			resolvePromise();
		}
	});
}

export function waitForClose(child, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for the driver to exit")), timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolvePromise({ code, signal });
		});
	});
}
