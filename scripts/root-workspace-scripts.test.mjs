#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

/**
 * Root scripts must reach into workspaces only through
 * scripts/run-workspaces.mjs, never through a package manager's own workspace
 * plumbing. The manager-flag shapes are not portable: bun rewrites `npm run`
 * to `bun run` and appends flags placed after the script name to the script
 * itself (`npm run test --workspaces` re-entered the root script forever,
 * #1293), bun's `--workspaces` fans out in parallel where npm is sequential,
 * and `npm --prefix <dir> run` / `npm --workspace=<name> run` /
 * `cd <dir> && npm run` always execute real npm even when the contributor
 * typed `bun run` or `pnpm run`. The driver runs every workspace script with
 * the manager that launched the root script, so the manifest must not encode
 * a manager choice of its own.
 *
 * `npm version --workspaces` is not a script delegation and stays: bun does
 * not rewrite it and it deliberately drives npm's version bookkeeping.
 */
const PACKAGE_MANAGERS = new Set(["npm", "bun", "pnpm", "yarn", "npx", "bunx"]);
const WORKSPACE_FLAG = /^(--workspaces?(=.*)?|-w|-ws|--prefix(=.*)?|--filter(=.*)?|-F|-r|--recursive)$/;

function tokenize(body) {
	return body.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function commandsOf(body) {
	// Split on &&, || and ; tokens (quoted lanes stay whole), then drop every
	// token from a standalone `--` on: those are forwarded to the script as
	// arguments, not parsed as package-manager flags.
	const commands = [[]];
	for (const token of tokenize(body)) {
		if (token === "&&" || token === "||" || token === ";") {
			commands.push([]);
			continue;
		}
		commands.at(-1).push(token);
	}
	return commands.map((tokens) => {
		const separator = tokens.indexOf("--");
		return separator === -1 ? tokens : tokens.slice(0, separator);
	});
}

export function delegationRisk(body) {
	for (const tokens of commandsOf(body)) {
		const command = tokens.join(" ");
		if (tokens[0] === "cd") return `\`cd\` into a workspace directory (${command})`;
		// Quoted sub-commands (concurrently lanes, sh -c bodies) are inspected recursively.
		for (const token of tokens) {
			if (/^(["']).*\1$/.test(token) && token.length >= 2) {
				const nested = delegationRisk(token.slice(1, -1));
				if (nested) return nested;
			}
		}
		const managerIndex = tokens.findIndex((token) => PACKAGE_MANAGERS.has(token));
		if (managerIndex === -1) continue;
		const rest = tokens.slice(managerIndex + 1);
		if (tokens[managerIndex] === "npm" && rest[0] === "version") continue;
		const flag = rest.find((token) => WORKSPACE_FLAG.test(token));
		if (flag) return `package-manager workspace flag ${flag} (${command})`;
	}
	return undefined;
}

test("root scripts reach workspaces only through scripts/run-workspaces.mjs", () => {
	const offenders = Object.entries(rootManifest.scripts ?? {})
		.map(([name, body]) => ({ name, body, risk: delegationRisk(body) }))
		.filter((entry) => entry.risk !== undefined)
		.map((entry) => `${entry.name}: ${entry.body}  <-- ${entry.risk}`);

	assert.deepEqual(
		offenders,
		[],
		`These root scripts hardcode a package manager to reach a workspace.\nUse \`node scripts/run-workspaces.mjs [--if-present] [--workspace <name|path>] <script>\` instead:\n${offenders.join("\n")}`,
	);
});

test("delegation guard flags every manager-flag shape and accepts the driver and root chaining", () => {
	const flagged = [
		"npm run test --workspaces --if-present",
		"npm run --workspaces --if-present test",
		"npm run --workspace=@scope/pkg eval --",
		"npm --workspace=@scope/pkg run eval --",
		"npm --prefix packages/ai run dev:tsc",
		"bun run --filter '*' test",
		"pnpm -r run test",
		'concurrently "cd packages/ai && npm run dev" "cd packages/tui && npm run dev"',
		"shx rm -rf dist && npm run --workspaces --if-present clean",
	];
	for (const body of flagged) assert.notEqual(delegationRisk(body), undefined, body);

	const accepted = [
		"npm run test:scripts && node scripts/run-workspaces.mjs --if-present test",
		"node scripts/run-workspaces.mjs --workspace packages/evals eval --",
		"npm version patch --workspaces --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js",
		"npm run build -- --workspace=foo",
		"biome check --write . && npm run check:pinned-deps && tsc --noEmit",
		"node scripts/build-all.mjs --pm bun",
	];
	for (const body of accepted) assert.equal(delegationRisk(body), undefined, body);
});
