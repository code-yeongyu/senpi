#!/usr/bin/env node
/**
 * Universal, idempotent dev-environment setup for senpi.
 *
 * One entry point shared by every harness — Claude Code, Codex, opencode,
 * Cursor, VS Code Dev Containers, GitHub Codespaces, and manual dev. The thin
 * scripts/devenv-setup.{sh,ps1} wrappers just locate Node and exec this file,
 * so the actual logic runs natively on macOS, Linux, and Windows.
 *
 * Safe to run repeatedly: every step checks before it acts.
 *
 * Flags:
 *   --no-install   skip `npm install` steps (just wire config + .env.local)
 *   --quiet        less chatter
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const NO_INSTALL = args.has("--no-install");
const isWindows = process.platform === "win32";

const log = (msg) => {
	if (!QUIET) process.stdout.write(`${msg}\n`);
};
const warn = (msg) => process.stdout.write(`! ${msg}\n`);

// The provider keys senpi reads (see packages/ai/src/env-api-keys.ts). The first
// one present in the environment is what we seed .env.local with.
const PROVIDER_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"XAI_API_KEY",
	"DEEPSEEK_API_KEY",
];

function hasCmd(cmd) {
	try {
		execFileSync(isWindows ? "where" : "which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function npm(cwd, npmArgs) {
	const bin = isWindows ? "npm.cmd" : "npm";
	execFileSync(bin, npmArgs, { cwd, stdio: "inherit" });
}

// 1. Runtime prerequisites -------------------------------------------------
function checkRuntime() {
	const major = Number(process.versions.node.split(".")[0]);
	if (major < 24) {
		warn(`Node ${process.versions.node} detected; senpi needs >= 24. Upgrade Node, then re-run.`);
		process.exit(1);
	}
	log(`Node ${process.versions.node} OK`);
	if (!hasCmd("git")) warn("git not found on PATH — clone/commit operations will fail.");
	for (const opt of ["rg", "tmux", "jq"]) {
		if (!hasCmd(opt)) {
			const why =
				opt === "tmux"
					? "POSIX TUI QA fallback (Windows uses node-pty instead)"
					: opt === "rg"
						? "fast in-agent search"
						: "JSON inspection in QA";
			log(`  (optional) ${opt} not found — ${why}`);
		}
	}
}

// 2. Dependencies ----------------------------------------------------------
function installDeps() {
	if (NO_INSTALL) {
		log("Skipping npm install (--no-install).");
		return;
	}
	if (!existsSync(join(ROOT, "node_modules"))) {
		log("Installing workspace dependencies (npm install --ignore-scripts)...");
		npm(ROOT, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
	} else {
		log("Workspace node_modules present — skipping.");
	}
	const skillDir = join(ROOT, ".agents", "skills", "senpi-qa");
	if (existsSync(join(skillDir, "package.json")) && !existsSync(join(skillDir, "node_modules"))) {
		log("Installing senpi-qa skill deps (node-pty for cross-platform TUI QA)...");
		try {
			npm(skillDir, ["install", "--no-audit", "--no-fund"]);
		} catch {
			warn("senpi-qa skill deps failed to install (node-pty native build). TUI QA falls back to tmux on POSIX.");
		}
	}
}

// 3. Credentials: .env.local ----------------------------------------------
async function ensureEnvLocal() {
	const envPath = join(ROOT, ".env.local");
	if (existsSync(envPath)) {
		log(".env.local present — leaving it untouched.");
		return;
	}
	let resolvedKeyName;
	let resolvedKeyValue;
	for (const name of PROVIDER_KEYS) {
		if (process.env[name]) {
			resolvedKeyName = name;
			resolvedKeyValue = process.env[name];
			break;
		}
	}
	if (!resolvedKeyValue && process.stdin.isTTY) {
		resolvedKeyValue = await prompt("Paste an ANTHROPIC_API_KEY (or press Enter to skip): ");
		if (resolvedKeyValue) resolvedKeyName = "ANTHROPIC_API_KEY";
	}

	const lines = [
		"# senpi local dev credentials — NEVER commit (gitignored).",
		"# senpi reads provider keys from the environment; QA loads this file.",
		"# Uncomment / fill the provider you use:",
		...PROVIDER_KEYS.map((k) => (k === resolvedKeyName ? `${k}=${resolvedKeyValue}` : `# ${k}=`)),
		"",
	];
	writeFileSync(envPath, lines.join("\n"));
	try {
		chmodSync(envPath, 0o600);
	} catch {}
	log(resolvedKeyValue ? `.env.local created (seeded ${resolvedKeyName}).` : ".env.local created (no key — add one).");
}

function prompt(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (a) => {
		rl.close();
		resolve(a.trim());
	}));
}

// 4. Claude Code skill discovery: .claude/skills -> ../.agents/skills ------
function ensureClaudeSkills() {
	const claudeDir = join(ROOT, ".claude");
	const link = join(claudeDir, "skills");
	if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
	if (existsSync(link)) {
		log(".claude/skills already exists — skipping symlink.");
		return;
	}
	try {
		const target = isWindows ? join(ROOT, ".agents", "skills") : join("..", ".agents", "skills");
		symlinkSync(target, link, isWindows ? "junction" : "dir");
		log(".claude/skills -> ../.agents/skills symlink created (Claude Code skill discovery).");
	} catch (e) {
		warn(`Could not create .claude/skills symlink: ${e instanceof Error ? e.message : e}. Create it manually for Claude Code.`);
	}
}

// 5. Keep per-machine wiring out of git -----------------------------------
function ensureGitExclude() {
	const excludePath = join(ROOT, ".git", "info", "exclude");
	if (!existsSync(excludePath)) return; // not a git checkout (e.g. tarball)
	const current = readFileSync(excludePath, "utf8");
	const want = [".claude", ".env.local", ".env.*.local"];
	const missing = want.filter((p) => !current.split(/\r?\n/).includes(p));
	if (missing.length) {
		appendFileSync(excludePath, `\n# senpi devenv (per-machine)\n${missing.join("\n")}\n`);
		log(`git info/exclude updated: ${missing.join(", ")}`);
	}
}

async function main() {
	log("=== senpi dev environment setup ===");
	checkRuntime();
	installDeps();
	await ensureEnvLocal();
	ensureClaudeSkills();
	ensureGitExclude();
	log("\nReady. Next:");
	log("  ./pi-test.sh                 run the TUI from source");
	log("  node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --self-test   verify QA harness");
	log("  See .agents/skills/senpi-qa/SKILL.md for the QA channels.");
}

main().then(
	() => process.exit(0),
	(e) => {
		warn(e instanceof Error ? e.stack : String(e));
		process.exit(1);
	},
);
