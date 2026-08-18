#!/usr/bin/env node
// Git and filesystem collectors shared by the changes.md PR gate and repository
// audit. Policy classification and tracker parsing stay in changes-md-policy.mjs.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTrackerPath } from "./changes-md-policy.mjs";

const GIT_REVISION_PATTERN = /^(?:[0-9a-fA-F]{4,40}|[A-Za-z0-9][A-Za-z0-9._/@~^{}-]*)$/;

/** Rejects option-like or metacharacter-bearing git revision arguments. */
export function validateGitRevision(value) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("invalid git revision: expected a non-empty revision");
	}
	if (value.startsWith("-") || /[\s;|&$`<>()]/.test(value) || !GIT_REVISION_PATTERN.test(value)) {
		throw new Error(`invalid git revision: ${value}`);
	}
	return value;
}

/** Runs git; throws on failure so callers fail closed. */
export function runGit(args, what) {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${what} failed:\n${(result.stderr ?? "").trim()}`);
	return result.stdout;
}

function splitLines(text) {
	return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Reads and validates the upstream pin; throws on unreadable or malformed metadata. */
export function readUpstreamPin(upstreamPath) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(upstreamPath, "utf8"));
	} catch (error) {
		throw new Error(`cannot read valid upstream pin metadata: ${upstreamPath} (${error.message})`);
	}
	const sha = typeof parsed?.sha === "string" ? parsed.sha.trim() : "";
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new Error(`malformed upstream pin metadata (no valid sha): ${upstreamPath}`);
	}
	return {
		repo: typeof parsed?.repo === "string" ? parsed.repo : "",
		tag: typeof parsed?.tag === "string" ? parsed.tag : "",
		sha,
	};
}

/** Fails closed when the pinned upstream commit is missing locally. */
export function ensureCommitExists(sha) {
	runGit(["cat-file", "-e", `${sha}^{commit}`], `verifying pinned upstream commit ${sha}`);
}

/** Parses `git diff --name-status` text into paths, renames, and deletions. */
export function parseNameStatus(text) {
	const changedFiles = [];
	const renames = [];
	const deletions = [];
	for (const line of splitLines(text)) {
		const [status, ...paths] = line.split("\t");
		if (paths.length === 0) continue;
		changedFiles.push(...paths);
		if (status.startsWith("R")) renames.push({ from: paths[0], to: paths[1] });
		else if (status.startsWith("D")) deletions.push(paths[0]);
	}
	return { changedFiles, renames, deletions };
}

/** Rename-aware PR diff (base...HEAD) with change kinds. */
export function resolvePrNameStatus(base) {
	const what = `git diff --name-status -M ${base}...HEAD`;
	return parseNameStatus(runGit(["diff", "--name-status", "-M", `${base}...HEAD`], what));
}

/** Every file in a commit tree; the upstream-ownership oracle. */
export function filesInCommit(sha) {
	return new Set(splitLines(runGit(["ls-tree", "-r", "--name-only", sha], `git ls-tree ${sha}`)));
}

/** All changes.md trackers in the working tree, repo-relative and sorted. */
export function listTrackerFiles(root) {
	const skipped = new Set([".git", "node_modules", "dist"]);
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (skipped.has(entry.name) || entry.isSymbolicLink()) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (isTrackerPath(entry.name)) found.push(full.replace(/\\/g, "/"));
		}
	};
	walk(root);
	return found.map((path) => path.replace(/^\.\//, "")).sort();
}
