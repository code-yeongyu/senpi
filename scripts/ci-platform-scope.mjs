#!/usr/bin/env node

// Decides whether a CI run needs the full macOS/Windows job set (senpi#3957, senpi#6834), and verifies the
// `Check and test` fan-in against that decision.
//
// Hosted macOS and Windows runners have little concurrency, and release runs queue behind pull requests for them, so
// a pull request (or a merge queue run) runs Linux only unless it carries the `run-full-ci` label; nothing in its diff
// turns the platform set on. Every other event (the push to main after the merge, a manual dispatch, a release
// calling the workflow) always runs the full set, and platform-red.yml reports a red macOS/Windows job there.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FULL_CI_LABEL = "run-full-ci";

// Jobs that run only on a macOS or Windows runner. Each is skipped when the run is not full, so the
// fan-in accepts `skipped` for exactly these jobs and only then.
export const PLATFORM_JOBS = [
	"macos-combined",
	"hooks-trust-storage-windows",
	"tui-mouse-windows",
	"tool-child-windows",
	"schedule-windows",
	"rpc-windows",
	"socket-secret-native-windows",
	"compiled-extensions-windows",
	"claude-executable-windows",
	"bash-grandchild-console-windows",
	"python-kernel-windows",
];

const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target", "merge_group"]);

/**
 * @param {{ event: string, labels: string[] }} input
 * @returns {{ full: boolean, reason: string }}
 */
export function classify({ event, labels }) {
	if (!PULL_REQUEST_EVENTS.has(event)) return { full: true, reason: `event ${event} always runs the full set` };
	if (labels.includes(FULL_CI_LABEL)) return { full: true, reason: `label ${FULL_CI_LABEL}` };
	return { full: false, reason: `${event} without the ${FULL_CI_LABEL} label runs Linux only` };
}

/**
 * @param {Record<string, { result: string }>} needs  the fan-in job's `needs` context
 * @param {string} full  platform-scope's `full` output; anything but "false" counts as a full run
 * @returns {string[]} one error per job that blocks the gate
 */
export function verifyNeeds(needs, full) {
	const skippable = full === "false" ? new Set(PLATFORM_JOBS) : new Set();
	return Object.entries(needs)
		.filter(([name, { result }]) => result !== "success" && !(result === "skipped" && skippable.has(name)))
		.map(([name, { result }]) => `${name} finished with result '${result}'`);
}

function argument(argv, name) {
	const index = argv.indexOf(`--${name}`);
	if (index === -1 || index + 1 >= argv.length) throw new Error(`missing --${name}`);
	return argv[index + 1];
}

function main(argv) {
	const [command, ...rest] = argv;
	if (command === "classify") {
		// Outside a pull request the labels expression renders as null.
		const labels = JSON.parse(argument(rest, "labels")) ?? [];
		if (!Array.isArray(labels)) throw new Error("--labels must be a JSON array");
		const decision = classify({ event: argument(rest, "event"), labels });
		console.log(`full=${decision.full} (${decision.reason})`);
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${decision.full}\n`);
		return 0;
	}
	if (command === "verify") {
		const needs = JSON.parse(process.env.NEEDS_JSON ?? "");
		const full = argument(rest, "full");
		for (const [name, { result }] of Object.entries(needs)) console.log(`${name}: ${result}`);
		const errors = verifyNeeds(needs, full);
		for (const error of errors) console.log(`::error::a required CI job ${error}`);
		return errors.length === 0 ? 0 : 1;
	}
	throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exitCode = main(process.argv.slice(2));
}
