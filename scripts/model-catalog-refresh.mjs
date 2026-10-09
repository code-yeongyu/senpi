#!/usr/bin/env node
/**
 * Prepare the daily model-catalog refresh PR (senpi#2943).
 *
 * After `generate-models` regenerated the catalog in a clean checkout of `main`, this script drops a manifest change
 * that is only the `generatedAt` stamp, reads which catalog files changed, writes the PR summary, and keeps exactly
 * one refresh entry under `## [Unreleased]` / `### Changed` in `packages/ai/CHANGELOG.md`, never touching a released
 * section (the Changelog gate rejects any edit there). It prints `changed=true|false` for `$GITHUB_OUTPUT`. GitHub
 * auto-merge then lands the PR once its required checks are green, so a release normally finds no catalog drift.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { discardTimestampOnlyCatalogChange, REGENERATED_CATALOG_PATHS } from "./release-test-gate.mjs";

export const REFRESH_ENTRY_PREFIX = "- The bundled model catalog is refreshed from models.dev";

const DATA_FILE = /^packages\/ai\/src\/providers\/data\/([^/.][^/]*)\.json$/;
const SHARD_FILE = /^packages\/ai\/src\/providers\/([^/]+)\.models\.ts$/;

/**
 * @param {string} porcelain `git status --porcelain --untracked-files=all` output for the catalog paths
 * @returns {{providers: string[], files: string[]}}
 */
export function changedCatalog(porcelain) {
	const files = porcelain
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter(Boolean)
		.sort();
	const providers = new Set();
	for (const file of files) {
		const id = DATA_FILE.exec(file)?.[1] ?? SHARD_FILE.exec(file)?.[1];
		if (id) providers.add(id);
	}
	return { providers: [...providers].sort(), files };
}

/**
 * @param {string[]} providers
 * @returns {string}
 */
export function refreshEntry(providers) {
	const list = providers.length > 0 ? providers.map((id) => `\`${id}\``).join(", ") : "the catalog aggregate";
	return `${REFRESH_ENTRY_PREFIX} and the providers' model listings (${list}).`;
}

/**
 * Put exactly one refresh entry under `## [Unreleased]` / `### Changed`. Only the `[Unreleased]` section is edited:
 * an earlier refresh entry there is replaced; one that already shipped in a released section stays as it is.
 * @param {string} changelog
 * @param {string[]} providers
 * @returns {string}
 */
export function withRefreshEntry(changelog, providers) {
	const lines = changelog.split("\n");
	const start = lines.findIndex((line) => line.trim() === "## [Unreleased]");
	if (start < 0) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
	const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const end = next < 0 ? lines.length : next;
	const section = lines.slice(start, end);
	const previous = section.findIndex((line) => line.startsWith(REFRESH_ENTRY_PREFIX));
	if (previous >= 0) {
		const blankAfter = section[previous + 1] === "" && section[previous - 1] === "";
		section.splice(previous, blankAfter ? 2 : 1);
	}
	const changed = section.findIndex((line) => line.trim() === "### Changed");
	const entry = refreshEntry(providers);
	if (changed >= 0) {
		section.splice(changed + 1, 0, "", entry);
	} else {
		while (section.length > 1 && section.at(-1) === "") section.pop();
		section.push("", "### Changed", "", entry, "");
	}
	return [...lines.slice(0, start), ...section, ...lines.slice(end)].join("\n");
}

/**
 * @param {{providers: string[], files: string[]}} change
 * @returns {string}
 */
export function summaryMarkdown(change) {
	return [
		"## Model catalog refresh",
		"",
		`The daily regeneration changed ${change.files.length} catalog file(s) for ${change.providers.length} provider(s): ${change.providers.map((id) => `\`${id}\``).join(", ") || "none (aggregate only)"}.`,
		"",
		"<details><summary>Changed files</summary>",
		"",
		...change.files.map((file) => `- \`${file}\``),
		"",
		"</details>",
		"",
		"This PR merges automatically once its required checks are green, so a release finds no catalog drift and reuses CI (#2943). When CI is red, typically a test that pins a model the catalog no longer lists (#2584), it stays open, and the scheduled run fails after it has waited too long.",
		"",
	].join("\n");
}

function main(argv) {
	const changelogIndex = argv.indexOf("--changelog");
	const summaryIndex = argv.indexOf("--summary");
	if (changelogIndex < 0 || summaryIndex < 0) {
		throw new Error("usage: node scripts/model-catalog-refresh.mjs --changelog <CHANGELOG.md> --summary <out.md>");
	}
	const changelogPath = argv[changelogIndex + 1];
	const summaryPath = argv[summaryIndex + 1];
	discardTimestampOnlyCatalogChange(process.cwd());
	const porcelain = execFileSync(
		"git",
		["status", "--porcelain", "--untracked-files=all", "--", ...REGENERATED_CATALOG_PATHS],
		{ encoding: "utf8" },
	);
	const change = changedCatalog(porcelain);
	if (change.files.length === 0) {
		process.stdout.write("changed=false\n");
		return;
	}
	writeFileSync(changelogPath, withRefreshEntry(readFileSync(changelogPath, "utf8"), change.providers));
	writeFileSync(summaryPath, summaryMarkdown(change));
	process.stdout.write("changed=true\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`[model-catalog-refresh] error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	}
}
