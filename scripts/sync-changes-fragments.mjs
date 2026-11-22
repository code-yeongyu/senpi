#!/usr/bin/env node
// Per-PR change fragments (senpi#3610): `compile` writes every changes/unreleased/<pr>.md into its logs and
// deletes it at the release cut before stamping; `from-diff` moves a
// branch's direct tracker/[Unreleased] additions into its fragment and restores those logs. Neither commits.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	FRAGMENT_DIR,
	FRAGMENT_README,
	fragmentPath,
	isChangelogTarget,
	parseFragment,
	planCompile,
	renderFragment,
} from "./changes-fragments.mjs";
import { runGit } from "./changes-md-git.mjs";
import { DEFAULT_UNRELEASED_SUBSECTIONS } from "./release-changelog.mjs";

const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const writeText = (path, content) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
};

export function compileFragments({ dryRun = false, log = console.log } = {}) {
	const names = existsSync(FRAGMENT_DIR) ? readdirSync(FRAGMENT_DIR) : [];
	const fragments = names
		.map((name) => `${FRAGMENT_DIR}/${name}`)
		.filter((path) => path !== FRAGMENT_README)
		.map((path) => ({ path, content: readText(path) }));
	const plan = planCompile(fragments, readText);
	if (plan.reasons.length > 0) throw new Error(plan.reasons.join("\n"));
	if (!dryRun) {
		for (const [path, content] of plan.writes) writeText(path, content);
		for (const path of plan.deletes) rmSync(path);
	}
	log(
		`changes-fragments: ${dryRun ? "would compile" : "compiled"} ${plan.deletes.length} fragment(s) into ${plan.writes.size} log(s)`,
	);
	return plan;
}

/** `### Section` -> bullet lines under ## [Unreleased]. */
function unreleasedBullets(text) {
	const out = new Map();
	let inside = false;
	let section;
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			inside = line.trim() === "## [Unreleased]";
			section = "## [Unreleased] (before any ### heading)";
			continue;
		}
		if (!inside) continue;
		if (line.startsWith("### ")) section = line.trim();
		else if (section && line.trim() !== "") out.set(section, [...(out.get(section) ?? []), line]);
	}
	return out;
}

const minus = (lines, remove) => {
	const left = [...remove];
	return lines.filter((line) => {
		const index = left.indexOf(line);
		if (index < 0) return true;
		left.splice(index, 1);
		return false;
	});
};

export function fromDiff({ base, pr, log = console.log }) {
	const mergeBase = runGit(["merge-base", base, "HEAD"], "resolving merge base").trim();
	const changed = runGit(["diff", "--name-status", "--no-renames", mergeBase, "--"], "listing changed logs")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"))
		.filter(([status, path]) => status === "M" && (/(^|\/)changes\.md$/.test(path) || isChangelogTarget(path)))
		.map(([, path]) => path)
		.sort();
	const target = fragmentPath(pr);
	const blocks = existsSync(target) ? parseFragment(readText(target)).blocks : [];
	const add = (logPath, body) => {
		const block = blocks.find((entry) => entry.log === logPath);
		if (block) block.body = `${block.body}\n\n${body}`;
		else blocks.push({ log: logPath, body });
	};
	for (const path of changed) {
		const before = runGit(["show", `${mergeBase}:${path}`], `reading base ${path}`);
		const after = readText(path);
		if (isChangelogTarget(path)) {
			const [was, now] = [unreleasedBullets(before), unreleasedBullets(after)];
			for (const [heading, lines] of now) {
				if (DEFAULT_UNRELEASED_SUBSECTIONS.includes(heading)) continue;
				const omitted = minus(lines, was.get(heading) ?? []);
				if (omitted.length > 0) {
					console.warn(
						`changes-fragments: warning: ${path}: omitted additions under ${heading}; reclassify these in ${target}:\n${omitted.join("\n")}`,
					);
				}
			}
			const sections = DEFAULT_UNRELEASED_SUBSECTIONS.flatMap((heading) => {
				const added = minus(now.get(heading) ?? [], was.get(heading) ?? []);
				return added.length > 0 ? [`${heading}\n${added.join("\n")}`] : [];
			});
			if (sections.length > 0) add(path, sections.join("\n\n"));
		} else {
			const diff = runGit(
				["diff", "--no-ext-diff", "--no-color", mergeBase, "--", path],
				`reading added lines in ${path}`,
			);
			let inHunk = false;
			const added = diff
				.split("\n")
				.filter((line) => {
					if (line.startsWith("@@ ")) inHunk = true;
					return inHunk && line.startsWith("+");
				})
				.map((line) => line.slice(1));
			const body = added.join("\n").trim();
			if (body !== "") add(path, body);
		}
		writeText(path, before);
	}
	const { reasons } = parseFragment(renderFragment(blocks));
	if (blocks.length > 0 && reasons.length > 0)
		throw new Error(`the converted ${target} is invalid: ${reasons.join("; ")}`);
	if (blocks.length > 0) writeText(target, renderFragment(blocks));
	log(`changes-fragments: moved ${changed.length} log edit(s) into ${target}; review it, then commit`);
}

export function main(argv) {
	const value = (name) => argv[argv.indexOf(`--${name}`) + 1];
	try {
		process.chdir(runGit(["rev-parse", "--show-toplevel"], "finding the repository root").trim());
		if (argv[0] === "compile") compileFragments({ dryRun: argv.includes("--dry-run") });
		else if (argv[0] === "from-diff" && argv.includes("--base") && /^[1-9]\d*$/.test(value("pr") ?? "")) {
			fromDiff({ base: value("base"), pr: Number(value("pr")) });
		} else {
			console.log("usage: node scripts/sync-changes-fragments.mjs compile [--dry-run]");
			console.log("       node scripts/sync-changes-fragments.mjs from-diff --base <ref> --pr <number>");
			return argv[0] === "--help" ? 0 : 1;
		}
		return 0;
	} catch (error) {
		console.error(`changes-fragments: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main(process.argv.slice(2)));
