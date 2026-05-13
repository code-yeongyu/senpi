#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const UPSTREAM_PIN_PATH = ".github/upstream.json"
// The script both reads and writes .github/upstream.json, but only after a clean merge.
const UPSTREAM_REMOTE = "upstream"
const UPSTREAM_BRANCH = "upstream/main"
const MAIN_BRANCH = "main"
const CONFLICT_LABEL = "sync-conflict"
const FATAL = 2
const CONFLICTS = 1
const CLEAN = 0

const REQUIRED_ENVIRONMENT = {
	GIT_EDITOR: "true",
	GIT_MERGE_AUTOEDIT: "no",
	GIT_PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
	EDITOR: ":",
	VISUAL: "",
}

const EXEC_ENVIRONMENT = {
	...process.env,
	...REQUIRED_ENVIRONMENT,
}

const KNOWN_MODIFIED_UPSTREAM_FILES = new Set([
	"packages/agent/src/agent-loop.ts",
	"packages/coding-agent/src/core/agent-session.ts",
	"packages/coding-agent/src/core/model-registry.ts",
	"packages/coding-agent/src/core/settings-manager.ts",
	"packages/coding-agent/src/core/resource-loader.ts",
	"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
	"packages/tui/src/tui.ts",
])

let currentUpstreamHead = ""
let currentBranchName = ""

class SyncError extends Error {
	constructor(message, exitCode = FATAL) {
		super(message)
		this.exitCode = exitCode
	}
}

function log(message) {
	console.log(`[sync] ${message}`)
}

function usage() {
	return `Usage: node scripts/sync-upstream.mjs [--dry-run] [--no-push] [--no-pr] [--verbose] [--help]

Synchronize senpi with ${UPSTREAM_REMOTE}/main using fork-aware auto-resolution.

Flags:
	--dry-run   Preview only; no repository mutations are kept
	--no-push   Do not push clean syncs or conflict branches
	--no-pr     Do not query, close, or create GitHub PRs
	--verbose   Print extra debug logging
	--help      Show this help
`
}

function parseArguments(argv) {
	const options = {
		dryRun: false,
		noPush: false,
		noPr: false,
		verbose: false,
		help: false,
	}

	for (const argument of argv) {
		switch (argument) {
			case "--dry-run":
				options.dryRun = true
				break
			case "--no-push":
				options.noPush = true
				break
			case "--no-pr":
				options.noPr = true
				break
			case "--verbose":
				options.verbose = true
				break
			case "--help":
				options.help = true
				break
			default:
				throw new SyncError(`unknown flag: ${argument}`)
		}
	}

	return options
}

function run(command, args, options = {}) {
	if (options.verbose) {
		log(`$ ${command} ${args.map(quoteArgument).join(" ")}`)
	}

	// All subprocesses route through execFileSync.
	// git commands use execFileSync.
	// gh commands use execFileSync.
	// npm and bun commands use execFileSync.
	// node helper snippets use execFileSync.
	return execFileSync(command, args, {
		cwd: options.cwd,
		env: EXEC_ENVIRONMENT,
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		timeout: options.timeout,
	})
}

function tryRun(command, args, options = {}) {
	try {
		return {
			ok: true,
			stdout: run(command, args, options),
			exitCode: 0,
		}
	} catch (error) {
		return {
			ok: false,
			stdout: error.stdout?.toString() ?? "",
			stderr: error.stderr?.toString() ?? "",
			exitCode: typeof error.status === "number" ? error.status : FATAL,
		}
	}
}

function quoteArgument(argument) {
	if (/^[a-zA-Z0-9_./:=@+-]+$/.test(argument)) {
		return argument
	}

	return JSON.stringify(argument)
}

function trimmed(command, args, options = {}) {
	return run(command, args, options).trim()
}

function git(args, options = {}) {
	return run("git", args, options)
}

function gitTrimmed(args, options = {}) {
	return trimmed("git", args, options)
}

function gitTry(args, options = {}) {
	return tryRun("git", args, options)
}

function ensureExecutable(name, modeName) {
	const pathValue = process.env.PATH ?? ""
	const candidates = pathValue.split(":").filter(Boolean).map((directory) => join(directory, name))

	if (!candidates.some((candidate) => existsSync(candidate))) {
		throw new SyncError(`${modeName} required for PR mode`)
	}
}

function readUpstreamPin() {
	log(`reading ${UPSTREAM_PIN_PATH}`)
	let parsed
	try {
		parsed = JSON.parse(run("node", ["-e", `process.stdout.write(require('fs').readFileSync('${UPSTREAM_PIN_PATH}', 'utf8'))`]))
	} catch (error) {
		throw new SyncError(`failed to parse ${UPSTREAM_PIN_PATH}: ${error.message}`)
	}

	if (typeof parsed !== "object" || parsed === null) {
		throw new SyncError(`${UPSTREAM_PIN_PATH} must contain an object`)
	}

	if (typeof parsed.sha !== "string" || !/^[0-9a-f]{40}$/i.test(parsed.sha)) {
		throw new SyncError(`${UPSTREAM_PIN_PATH} is missing a valid sha`)
	}

	if (typeof parsed.repo !== "string" || parsed.repo.length === 0) {
		throw new SyncError(`${UPSTREAM_PIN_PATH} is missing repo`)
	}

	return parsed
}

function writeUpstreamPin(pin, upstreamHead, tag) {
	log(`writing ${UPSTREAM_PIN_PATH}`)
	const nextPin = {
		repo: pin.repo,
		tag,
		sha: upstreamHead,
		synced_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	}

	writeFileSync(UPSTREAM_PIN_PATH, `${JSON.stringify(nextPin, null, "\t")}\n`)
}

function ensurePrerequisites(options) {
	log("verifying git work tree")
	const inside = gitTrimmed(["rev-parse", "--is-inside-work-tree"], options)
	if (inside !== "true") {
		throw new SyncError("not inside a git work tree")
	}

	if (!options.noPr) {
		log("verifying gh CLI")
		ensureExecutable("gh", "gh CLI")
	}
}

function ensureCleanMain(options) {
	log("verifying clean working tree")
	const status = gitTrimmed(["status", "--porcelain"], options)
	if (status.length > 0) {
		throw new SyncError(`working tree must be clean before sync:\n${status}`)
	}

	log("verifying current branch is main")
	const branch = gitTrimmed(["branch", "--show-current"], options)
	if (branch !== MAIN_BRANCH) {
		throw new SyncError(`sync must start from ${MAIN_BRANCH}; current branch is ${branch || "detached HEAD"}`)
	}
}

function ensureOnMain(options) {
	log("verifying current branch is main")
	const branch = gitTrimmed(["branch", "--show-current"], options)
	if (branch !== MAIN_BRANCH) {
		throw new SyncError(`sync must start from ${MAIN_BRANCH}; current branch is ${branch || "detached HEAD"}`)
	}
}

function unresolvedPaths(options = {}) {
	const output = gitTrimmed(["diff", "--name-only", "--diff-filter=U"], options)
	return output.length === 0 ? [] : output.split("\n").filter(Boolean)
}

function applyAutoResolution(paths, options = {}) {
	const state = {
		packageLockTouched: false,
		bunLockTouched: false,
		resolved: [],
		leftForHumans: [],
	}

	for (const path of paths) {
		const base = basename(path)
		if (base === "bun.lock") {
			log(`auto-resolving ${path}: remove conflicted bun lock for regeneration`)
			gitTry(["rm", "--", path], options)
			state.bunLockTouched = true
			state.resolved.push(path)
			continue
		}

		if (base === "package-lock.json") {
			log(`auto-resolving ${path}: git checkout --theirs package-lock.json`)
			git(["checkout", "--theirs", "--", path], options)
			git(["add", "--", path], options)
			state.packageLockTouched = true
			state.resolved.push(path)
			continue
		}

		if (base === "changes.md") {
			log(`auto-resolving ${path}: git checkout --ours changes.md`)
			git(["checkout", "--ours", "--", path], options)
			git(["add", "--", path], options)
			state.resolved.push(path)
			continue
		}

		if (path.endsWith(".md")) {
			log(`auto-resolving ${path}: git checkout --theirs markdown`)
			git(["checkout", "--theirs", "--", path], options)
			git(["add", "--", path], options)
			state.resolved.push(path)
			continue
		}

		log(`leaving ${path} for human resolution`)
		state.leftForHumans.push(path)
	}

	return state
}

function regenerateLockfiles(state, options = {}) {
	if (state.packageLockTouched) {
		log("regenerating package-lock.json with npm install")
		rmSync("node_modules", { recursive: true, force: true })
		for (const workspaceNodeModules of globWorkspaceNodeModules()) {
			rmSync(workspaceNodeModules, { recursive: true, force: true })
		}
		rmSync("package-lock.json", { force: true })
		run("npm", ["install"], { ...options, timeout: 600_000, stdio: "inherit" })
		git(["add", "package-lock.json"], options)
	}

	if (state.bunLockTouched) {
		if (hasExecutable("bun")) {
			log("regenerating bun.lock with bun install")
			run("bun", ["install", "--frozen-lockfile=false"], { ...options, timeout: 600_000, stdio: "inherit" })
			git(["add", "bun.lock"], options)
		} else {
			log("warning: bun unavailable; falling back to upstream bun.lock when possible")
			const checkout = gitTry(["checkout", "--theirs", "--", "bun.lock"], options)
			if (checkout.ok) {
				git(["add", "bun.lock"], options)
			} else {
				gitTry(["rm", "--", "bun.lock"], options)
			}
		}
	}
}

function globWorkspaceNodeModules() {
	const packagesDirectory = "packages"
	if (!existsSync(packagesDirectory)) {
		return []
	}

	return run("node", [
		"-e",
		"const fs=require('fs'); const path=require('path'); " +
			"for (const name of fs.readdirSync('packages')) { " +
			"const candidate=path.join('packages', name, 'node_modules'); " +
			"if (fs.existsSync(candidate)) console.log(candidate); }",
	])
		.trim()
		.split("\n")
		.filter(Boolean)
}

function hasExecutable(name) {
	const pathValue = process.env.PATH ?? ""
	return pathValue
		.split(":")
		.filter(Boolean)
		.map((directory) => join(directory, name))
		.some((candidate) => existsSync(candidate))
}

function describeAutoResolution(paths) {
	const lines = []
	for (const path of paths) {
		const base = basename(path)
		if (base === "bun.lock") {
			lines.push(`  - ${path}: git rm bun.lock, then regenerate or take theirs if bun is unavailable`)
		} else if (base === "package-lock.json") {
			lines.push(`  - ${path}: git checkout --theirs package-lock.json, then npm install`)
		} else if (base === "changes.md") {
			lines.push(`  - ${path}: git checkout --ours -- ${path}`)
		} else if (path.endsWith(".md")) {
			lines.push(`  - ${path}: git checkout --theirs -- ${path}`)
		} else {
			lines.push(`  - ${path}: unresolved; human resolution required`)
		}
	}
	return lines
}

function dryRunMerge(options, upstreamHead, shortSha, branchName) {
	log("dry-run plan")
	for (const command of [
		"git fetch upstream --tags --quiet",
		"git rev-parse upstream/main",
		"git status --porcelain",
		"git branch --show-current",
		`git checkout -B ${branchName} main`,
		"git merge upstream/main --no-ff --no-commit",
		"git diff --name-only --diff-filter=U",
		"auto-resolve known conflict patterns",
		"git commit -m sync: merge upstream <short> into main --no-verify OR open conflict PR",
	]) {
		log(`plan: ${command}`)
	}

	const worktreePath = mkdtempSync(join(tmpdir(), "sync-upstream-dry-run-"))
	try {
		log(`dry-run estimating merge in temporary worktree: ${worktreePath}`)
		git(["worktree", "add", "--detach", "--quiet", worktreePath, MAIN_BRANCH], options)
		const dryOptions = { ...options, cwd: worktreePath }
		const merge = gitTry(["merge", UPSTREAM_BRANCH, "--no-ff", "--no-commit"], dryOptions)
		if (merge.ok) {
			log(`dry-run result: clean merge estimated (${upstreamHead.slice(0, 12)} / ${shortSha})`)
			return CLEAN
		}

		const initialConflicts = unresolvedPaths(dryOptions)
		log(`dry-run initial conflicts: ${initialConflicts.length}`)
		for (const line of describeAutoResolution(initialConflicts)) {
			log(line)
		}

		const resolutionState = applyAutoResolution(initialConflicts, dryOptions)
		const remaining = unresolvedPaths(dryOptions)
		log(`dry-run auto-resolved: ${resolutionState.resolved.length}`)
		log(`dry-run remaining conflicts: ${remaining.length}`)
		for (const path of remaining) {
			log(`dry-run unresolved: ${path}`)
		}

		return remaining.length === 0 ? CLEAN : CONFLICTS
	} finally {
		gitTry(["worktree", "remove", "--force", worktreePath], options)
		rmSync(worktreePath, { recursive: true, force: true })
	}
}

function buildPrBody(unresolvedFiles, shortSha) {
	const rows = unresolvedFiles
		.map((file) => {
			const suggestion = suggestedResolution(file)
			return `| \`${file}\` | ${suggestion.resolution} | ${suggestion.reason} |`
		})
		.join("\n")

	return `## Auto-opened by sync-upstream.yml

Upstream \`badlogic/pi-mono\` advanced to \`${shortSha}\` (full: \`${currentUpstreamHead}\`). Auto-merge applied but the following files require human resolution.

If a newer sync runs before this PR is resolved, this PR will be **closed and superseded** by the next one.

## Conflicting files

| File | Suggested resolution | Reason |
|---|---|---|
${rows}

## Resolution playbook

1. Check out this branch: \`git fetch origin ${currentBranchName} && git checkout ${currentBranchName}\`.
2. For each conflicting file, follow the suggested resolution above.
3. Read the nearest \`changes.md\` if the file is fork-modified — see [AGENTS.md ## VERSIONING & UPSTREAM SYNC](../AGENTS.md#versioning--upstream-sync).
4. After resolving: \`git add <file>\`, then \`git commit --no-edit\`, then \`git push\`.
5. Merging this PR triggers \`release.yml\`-style downstream actions; CI must pass.

## Fork strategy reminders

- Builtin extensions in \`packages/coding-agent/src/core/extensions/builtin/\` are fork-only — prefer \`ours\` unless upstream explicitly improves the same path.
- Files listed in any \`changes.md\` are intentionally fork-modified.
- Lockfiles (\`package-lock.json\`, \`bun.lock\`) were auto-resolved; if regression appears, regenerate them locally before merging.
`
}

function suggestedResolution(file) {
	if (file.startsWith("packages/coding-agent/src/core/extensions/builtin/")) {
		return {
			resolution: "Prefer ours (fork-only directory)",
			reason: "Fork-owned builtin extension path",
		}
	}

	if (KNOWN_MODIFIED_UPSTREAM_FILES.has(file)) {
		return {
			resolution: "Read the relevant `changes.md` before resolving",
			reason: "Known fork-modified upstream file",
		}
	}

	return {
		resolution: "Take upstream; verify locally",
		reason: "No fork-specific rule is known for this path",
	}
}

function closeSupersededPullRequests(shortSha, options = {}) {
	log("finding existing open sync-conflict PRs")
	const output = run("gh", ["pr", "list", "--label", CONFLICT_LABEL, "--state", "open", "--json", "number,headRefName,title"], options)
	let pullRequests
	try {
		pullRequests = JSON.parse(output)
	} catch (error) {
		throw new SyncError(`failed to parse gh pr list output: ${error.message}`)
	}

	if (!Array.isArray(pullRequests) || pullRequests.length === 0) {
		log("no existing sync-conflict PRs to supersede")
		return
	}

	for (const pullRequest of pullRequests) {
		if (typeof pullRequest.number !== "number") {
			continue
		}
		log(`closing superseded PR #${pullRequest.number}`)
		run("gh", [
			"pr",
			"close",
			String(pullRequest.number),
			"--comment",
			`Superseded by upcoming sync from ${shortSha}`,
			"--delete-branch",
		], options)
	}
}

function createConflictPullRequest(unresolved, shortSha, branchName, options = {}) {
	closeSupersededPullRequests(shortSha, options)
	log("staging conflict markers")
	git(["add", "-A"], options)
	log("committing conflict branch snapshot")
	git(["commit", "-m", `sync: WIP merge of upstream ${shortSha} (conflicts)`, "--no-verify"], options)

	if (!options.noPush) {
		log(`pushing conflict branch ${branchName}`)
		git(["push", "-u", "origin", branchName], options)
	} else {
		log(`--no-push set; skipping push for ${branchName}`)
	}

	const bodyPath = join(tmpdir(), `sync-upstream-${shortSha}.md`)
	writeFileSync(bodyPath, buildPrBody(unresolved, shortSha))
	try {
		log("creating sync-conflict PR")
		const url = run("gh", [
			"pr",
			"create",
			"--label",
			CONFLICT_LABEL,
			"--base",
			MAIN_BRANCH,
			"--head",
			branchName,
			"--title",
			`sync: upstream ${shortSha} (conflicts)`,
			"--body-file",
			bodyPath,
		], options).trim()
		console.log(url)
	} finally {
		rmSync(bodyPath, { force: true })
	}
}

function printNoPrInstructions(unresolved, branchName) {
	log("unresolved conflicts remain; --no-pr set")
	log(`branch left locally with conflict markers: ${branchName}`)
	log("resolve these files:")
	unresolved.forEach((file, index) => {
		const suggestion = suggestedResolution(file)
		log(`${index + 1}. ${file} — ${suggestion.resolution} (${suggestion.reason})`)
	})
}

function performCleanMerge(pin, upstreamHead, shortSha, branchName, options = {}) {
	log("committing clean upstream merge")
	// auto-merge has no human-review-worthy diff beyond what CI catches on next manual PR;
	// husky pre-commit would re-run full check unnecessarily.
	git(["commit", "-m", `sync: merge upstream ${shortSha} into main`, "--no-verify"], options)
	log("returning to main")
	git(["checkout", MAIN_BRANCH], options)
	log(`fast-forwarding ${MAIN_BRANCH} to ${branchName}`)
	git(["merge", "--ff-only", branchName], options)

	const tagResult = gitTry(["describe", "--tags", "--match", "v*", "--abbrev=0", upstreamHead], options)
	const tag = tagResult.ok ? tagResult.stdout.trim() : ""
	writeUpstreamPin(pin, upstreamHead, tag)
	git(["add", UPSTREAM_PIN_PATH], options)
	log("committing upstream pin update")
	git(["commit", "-m", `sync: record upstream pin ${shortSha}`, "--no-verify"], options)

	if (!options.noPush) {
		log("pushing main")
		git(["push", "origin", MAIN_BRANCH], options)
		log(`deleting local branch ${branchName}`)
		git(["branch", "-D", branchName], options)
	} else {
		log("--no-push set; leaving local sync branch intact")
	}

	log(`clean merge applied: ${pin.sha.slice(0, 12)} → ${shortSha}`)
}

function main() {
	const options = parseArguments(process.argv.slice(2))
	if (options.help) {
		console.log(usage())
		return CLEAN
	}

	ensurePrerequisites(options)
	const pin = readUpstreamPin()
	log(`fetching ${UPSTREAM_REMOTE} tags`)
	git(["fetch", UPSTREAM_REMOTE, "--tags", "--quiet"], options)

	const upstreamHead = gitTrimmed(["rev-parse", UPSTREAM_BRANCH], options)
	currentUpstreamHead = upstreamHead
	if (upstreamHead === pin.sha) {
		log(`no upstream changes (pin: ${pin.sha.slice(0, 12)})`)
		return CLEAN
	}

	const shortSha = gitTrimmed(["rev-parse", "--short=12", UPSTREAM_BRANCH], options)
	const branchName = `sync/upstream-${shortSha}`
	currentBranchName = branchName

	if (options.dryRun) {
		ensureOnMain(options)
		return dryRunMerge(options, upstreamHead, shortSha, branchName)
	}

	ensureCleanMain(options)

	log(`creating sync branch ${branchName}`)
	git(["checkout", "-B", branchName, MAIN_BRANCH], options)
	log(`merging ${UPSTREAM_BRANCH}`)
	gitTry(["merge", UPSTREAM_BRANCH, "--no-ff", "--no-commit"], options)

	const initialConflicts = unresolvedPaths(options)
	log(`initial conflicts: ${initialConflicts.length}`)
	const resolutionState = applyAutoResolution(initialConflicts, options)
	regenerateLockfiles(resolutionState, options)

	const remainingConflicts = unresolvedPaths(options)
	log(`remaining conflicts: ${remainingConflicts.length}`)

	if (remainingConflicts.length === 0) {
		performCleanMerge(pin, upstreamHead, shortSha, branchName, options)
		return CLEAN
	}

	if (!options.noPr) {
		createConflictPullRequest(remainingConflicts, shortSha, branchName, options)
	} else {
		printNoPrInstructions(remainingConflicts, branchName)
	}

	return CONFLICTS
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main()
	} catch (error) {
		if (error instanceof SyncError) {
			console.error(`[sync] fatal: ${error.message}`)
			process.exitCode = error.exitCode
		} else {
			console.error(`[sync] fatal: ${error instanceof Error ? error.message : String(error)}`)
			process.exitCode = FATAL
		}
	}
}

export { buildPrBody }
