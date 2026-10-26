#!/usr/bin/env node
// Both catalog workflows use the existing automation PAT. New PRs stay draft until
// their numeric fragment is pushed; existing PR numbers are checked before any write.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fragmentPath, parseFragment } from "./changes-fragments.mjs";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const repo = process.env.GITHUB_REPOSITORY;
const branch = process.env.REFRESH_BRANCH;
const title = option("--title");
const summary = option("--summary");
const fragmentFile = option("--fragment");
const paths = args.slice(args.indexOf("--") + 1);
const gh = (...argv) => execFileSync("gh", argv, { encoding: "utf8" }).trim();
const git = (...argv) => execFileSync("git", argv, { stdio: "inherit" });

try {
	if (!repo || !branch || !process.env.GH_TOKEN ||
		!["--title", "--summary", "--fragment", "--"].every((flag) => args.includes(flag))) {
		throw new Error("requires GH_TOKEN, GITHUB_REPOSITORY, REFRESH_BRANCH, --title, --summary, --fragment and -- <catalog paths>");
	}
	const inspect = (numberOrUrl) => {
		const pr = JSON.parse(gh("pr", "view", String(numberOrUrl), "--repo", repo,
			"--json", "number,url,headRefName,baseRefName,state,isCrossRepository,isDraft"));
		if (!Number.isSafeInteger(pr.number) || pr.number < 1 ||
			pr.url !== `https://github.com/${repo}/pull/${pr.number}` ||
			pr.headRefName !== branch || pr.baseRefName !== "main" ||
			pr.state !== "OPEN" || pr.isCrossRepository) {
			throw new Error("refusing a fragment for a PR outside this repository, branch, and open main target");
		}
		return pr;
	};
	const listed = gh("pr", "list", "--repo", repo, "--head", branch, "--base", "main",
		"--state", "open", "--json", "number");
	const matches = JSON.parse(listed);
	if (matches.length > 1) throw new Error("multiple open refresh PRs");
	let pr = matches.length === 1 ? inspect(matches[0].number) : undefined;
	if (process.env.CHANGED !== "true") {
		if (pr) gh("pr", "close", String(pr.number), "--repo", repo, "--delete-branch",
			"--comment", "The catalog on main is current again; closing this refresh.");
		process.exit(0);
	}
	const content = readFileSync(fragmentFile, "utf8");
	const parsed = parseFragment(content);
	if (parsed.reasons.length || parsed.blocks.length !== 1 || parsed.blocks[0].log !== "packages/ai/CHANGELOG.md") {
		throw new Error("refresh must supply one valid AI changelog fragment block");
	}
	const writeFragment = () => {
		const path = fragmentPath(pr.number);
		if (existsSync(path)) throw new Error(`refusing to overwrite existing ${path}`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		return path;
	};
	git("config", "user.name", "senpi-release-bot");
	git("config", "user.email", "actions@github.com");
	git("checkout", "-B", branch);
	const staged = [...paths];
	if (pr) staged.push(writeFragment());
	git("add", "--", ...staged);
	// This repository also runs CI on drafts. Only the incomplete seed head skips it;
	// the following fragment commit has no skip marker and is pushed with the PAT.
	git("commit", "-m", pr ? title : `${title} [skip ci]`);
	// gh uses GH_TOKEN (UPSTREAM_AUTOMATION_TOKEN in both workflows), not GITHUB_TOKEN.
	gh("auth", "setup-git", "--hostname", "github.com");
	git("push", "--force", "origin", `HEAD:refs/heads/${branch}`);
	if (!pr) {
		const url = gh("pr", "create", "--repo", repo, "--base", "main", "--head", branch,
			"--draft", "--title", title, "--body-file", summary);
		pr = inspect(url);
		git("add", "--", writeFragment());
		git("commit", "-m", "fix(ai): attach catalog refresh fragment");
		git("push", "origin", `HEAD:refs/heads/${branch}`);
	} else {
		gh("pr", "edit", String(pr.number), "--repo", repo, "--body-file", summary);
	}
	if (pr.isDraft) gh("pr", "ready", String(pr.number), "--repo", repo);
	if (args.includes("--auto-merge")) gh("pr", "merge", String(pr.number), "--repo", repo, "--auto", "--merge");
} catch (error) {
	console.error(`catalog-refresh: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
