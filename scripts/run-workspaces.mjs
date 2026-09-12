#!/usr/bin/env node
// PM-agnostic root -> workspace script runner.
//
// Root scripts used to reach into workspaces through package-manager flags:
// `npm run --workspaces --if-present test`, `npm --workspace=<name> run eval`,
// `npm --prefix packages/ai run <script>`. Those shapes mean different things
// to different package managers. bun rewrites `npm run` to `bun run` and
// appends flags placed after the script name to the script itself (the root
// recursion fixed in #1293), bun's `--workspaces` fans out in parallel where
// npm runs sequentially, and `--prefix` / `--workspace=` always invoke real
// npm even when the contributor typed `bun run` or `pnpm run`. This driver
// owns the fan-out instead: it resolves the root "workspaces" field, runs
// `<pm> run <script>` in each workspace with the package manager that
// launched the root script, sequentially and in path order, never re-enters
// the root manifest, and reports one PASS / SKIP / FAIL summary.
//
// Usage:
//   node scripts/run-workspaces.mjs [--if-present] [--workspace <name|path>]... <script> [-- <args>]
//
//   --if-present            skip workspaces that do not define <script> instead of failing
//   --workspace <selector>  run only that workspace (package name or repo-relative path); repeatable
//   -- <args>               forwarded verbatim to every workspace script
//
// Exit code: 0 when every run passed; otherwise the first failing workspace's
// exit code; 1 when a selected workspace lacks the script and --if-present is
// not set; 2 on usage or manifest errors. Options may appear on either side of
// the script name because package managers append caller arguments after it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv, detectPackageManager, runScriptArguments, spawnPackageManager } from "./package-manager.mjs";

const LABEL = "run-workspaces";

export class UsageError extends Error {}

export function parseArguments(argv) {
	const parsed = { script: undefined, ifPresent: false, workspaces: [], forwarded: [] };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--") {
			parsed.forwarded = argv.slice(index + 1);
			break;
		}
		if (argument === "--if-present") {
			parsed.ifPresent = true;
			continue;
		}
		if (argument === "--workspace") {
			const selector = argv[++index];
			if (selector === undefined || selector === "--") throw new UsageError("--workspace requires a package name or path");
			parsed.workspaces.push(selector);
			continue;
		}
		if (argument.startsWith("--workspace=")) {
			parsed.workspaces.push(argument.slice("--workspace=".length));
			continue;
		}
		if (argument.startsWith("-")) throw new UsageError(`unknown argument: ${argument}`);
		if (parsed.script !== undefined) {
			throw new UsageError(`unexpected argument "${argument}" (forward script arguments after --)`);
		}
		parsed.script = argument;
	}
	if (parsed.script === undefined) throw new UsageError("script name is required");
	return parsed;
}

function readManifest(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function toPosixPath(path) {
	return path.split(sep).join("/");
}

function normalizePattern(pattern) {
	return toPosixPath(pattern)
		.replace(/^\.\//, "")
		.replace(/\/+$/, "");
}

/**
 * Expands one "workspaces" entry. Supports exact paths and `*` as a whole path
 * segment (`packages/*`, `packages/session-backends/*`), which is every shape
 * this repository uses; any other glob syntax fails loudly instead of silently
 * matching nothing.
 */
function expandPattern(rootDirectory, pattern) {
	const segments = normalizePattern(pattern).split("/");
	let directories = [rootDirectory];
	for (const segment of segments) {
		if (segment === "*") {
			directories = directories.flatMap((directory) => {
				if (!existsSync(directory)) return [];
				return readdirSync(directory, { withFileTypes: true })
					.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
					.map((entry) => join(directory, entry.name));
			});
			continue;
		}
		if (/[*?[\]{}!]/.test(segment)) {
			throw new UsageError(`unsupported workspace pattern "${pattern}" (only "*" as a whole path segment is supported)`);
		}
		directories = directories.map((directory) => join(directory, segment));
	}
	return directories.filter((directory) => existsSync(join(directory, "package.json")));
}

export async function resolveWorkspaceDirectories(rootDirectory) {
	const manifest = readManifest(rootDirectory);
	const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
	if (!Array.isArray(patterns)) {
		throw new UsageError(`${join(rootDirectory, "package.json")} has no "workspaces" field; run from the workspace root`);
	}
	const byPath = new Map();
	for (const pattern of patterns) {
		for (const directory of expandPattern(rootDirectory, pattern)) {
			const relativePath = toPosixPath(directory.slice(rootDirectory.length + 1));
			if (byPath.has(relativePath)) continue;
			const workspaceManifest = readManifest(directory);
			byPath.set(relativePath, {
				directory,
				relativePath,
				name: workspaceManifest.name ?? relativePath,
				scripts: workspaceManifest.scripts ?? {},
			});
		}
	}
	return [...byPath.values()].sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
}

function selectWorkspaces(workspaces, selectors) {
	if (selectors.length === 0) return workspaces;
	const selected = new Set();
	for (const selector of selectors) {
		const normalized = normalizePattern(selector);
		const match = workspaces.find((workspace) => workspace.name === selector || workspace.relativePath === normalized);
		if (!match) throw new UsageError(`unknown workspace "${selector}" (expected a package name or a path relative to the root)`);
		selected.add(match);
	}
	return workspaces.filter((workspace) => selected.has(workspace));
}

function describe(workspace) {
	return `${workspace.relativePath} (${workspace.name})`;
}

export async function runWorkspaces(argv, { rootDirectory = process.cwd(), env = process.env } = {}) {
	const { script, ifPresent, workspaces: selectors, forwarded } = parseArguments(argv);
	const selected = selectWorkspaces(await resolveWorkspaceDirectories(rootDirectory), selectors);
	const missing = selected.filter((workspace) => typeof workspace.scripts[script] !== "string");
	if (missing.length > 0 && !ifPresent) {
		for (const workspace of missing) console.error(`[${LABEL}] ${describe(workspace)}: no "${script}" script`);
		console.error(`[${LABEL}] pass --if-present to skip workspaces without a "${script}" script`);
		return 1;
	}

	const pm = detectPackageManager(env);
	const childEnv = cleanEnv(env);
	const pmArgs = runScriptArguments(pm, script, forwarded);
	const results = [];
	for (const workspace of selected) {
		if (missing.includes(workspace)) {
			results.push({ workspace, verdict: "SKIP", detail: `no "${script}" script` });
			continue;
		}
		console.log(`\n[${LABEL}] > ${describe(workspace)}: ${pm.cmd} ${pmArgs.join(" ")}`);
		const status = await spawnPackageManager(pm, pmArgs, { cwd: workspace.directory, env: childEnv, label: LABEL });
		results.push(
			status === 0
				? { workspace, verdict: "PASS", detail: "" }
				: { workspace, verdict: "FAIL", detail: `exit ${status}`, status },
		);
	}

	console.log(`\n[${LABEL}] summary for "${script}" (${pm.cmd}):`);
	for (const result of results) {
		console.log(`  ${result.verdict} ${describe(result.workspace)}${result.detail ? ` - ${result.detail}` : ""}`);
	}
	const failures = results.filter((result) => result.verdict === "FAIL");
	if (failures.length > 0) {
		const ran = results.filter((result) => result.verdict !== "SKIP").length;
		console.error(`[${LABEL}] ${failures.length} of ${ran} workspace run(s) failed`);
	}
	return failures.length > 0 ? failures[0].status : 0;
}

async function main() {
	try {
		process.exitCode = await runWorkspaces(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`[${LABEL}] ${error.message}`);
			console.error(
				"usage: node scripts/run-workspaces.mjs [--if-present] [--workspace <name|path>]... <script> [-- <args>]",
			);
			process.exitCode = 2;
			return;
		}
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
