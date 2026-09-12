#!/usr/bin/env node
// Issue #723 real-surface probe: a stream-start-stalled headless turn must retry
// by forking at the pre-turn assistant boundary (delta re-send, prefix-cache
// read), never by re-attaching and re-sending the full conversation.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootHermeticStack, SOURCE_ROOT } from "./lib/claude-sdk-oauth-fullstack-harness.mjs";
import { classifyPayload } from "./lib/claude-sdk-oauth-fullstack-support.mjs";
import { safeDetail } from "./lib/output-safety.mjs";

const TURN_TIMEOUT_MS = 120_000;
const tsxImport = fileURLToPath(import.meta.resolve("tsx"));
const evidenceArg = process.argv.indexOf("--evidence");
const evidenceSlug = evidenceArg === -1 ? undefined : process.argv[evidenceArg + 1];

function killTree(child) {
	if (child.exitCode !== null) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function runCli(stack, args, onLine) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", tsxImport, join(SOURCE_ROOT, "cli.ts"), ...args], {
			cwd: stack.box.cwd,
			detached: process.platform !== "win32",
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (onLine) for (const line of chunk.split("\n")) onLine(line);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timeout = setTimeout(() => {
			killTree(child);
			reject(new Error(`CLI turn exceeded ${TURN_TIMEOUT_MS}ms`));
		}, TURN_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

function events(stdout, type) {
	const out = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const visit = (value) => {
			if (Array.isArray(value)) return value.forEach(visit);
			if (!value || typeof value !== "object") return;
			if (value.type === type) out.push(value);
			for (const nested of Object.values(value)) visit(nested);
		};
		visit(parsed);
	}
	return out;
}

function seedFastTimeoutSettings(stack) {
	writeFileSync(
		join(stack.box.agentDir, "settings.json"),
		JSON.stringify({
			retry: { enabled: true, baseDelayMs: 0, provider: { streamStartTimeoutMs: 3000, streamRetryTimeoutMs: 0 } },
		}),
	);
}

const common = (sessionDir) => [
	"-p",
	"--provider", "claude-sdk-oauth",
	"--model", "claude-haiku-4-5",
	"--thinking", "off",
	"--mode", "json",
	"--session-dir", sessionDir,
	"--no-tools",
	"--no-context-files",
	"--offline",
	"--no-model-fallback",
	"--no-recommended-models",
	"--system-prompt", "Reply with the requested marker only.",
];

let stack;
let summary;
const cleanup = [];
try {
	stack = await bootHermeticStack({ sandboxLabel: "issue-723-stream-stall-retry" });
	seedFastTimeoutSettings(stack);

	// Turn 1: normal — establishes lineage + persisted binding.
	const first = await runCli(stack, [...common(stack.box.sessionDir), "Reply exactly STALL-1."]);
	if (first.code !== 0) throw new Error(`turn 1 failed (${first.code}): ${safeDetail(first.stderr.slice(-400))}`);
	const payloadsBeforeStall = stack.creations.reduce((n, c) => n + c.payloads.length, 0);

	// Turn 2: stall the FIRST provider request, watch for the retry's payload.
	const releaseStall = stack.stallNextResponse();
	const retryPayloads = [];
	const second = await runCli(
		stack,
		[...common(stack.box.sessionDir), "-c", "Reply exactly STALL-2."],
		(line) => {
			if (line.includes("auto_retry_start")) {
				// The stalled first attempt timed out and the retry is about to fire:
				// let the loopback answer normally now.
				releaseStall();
			}
		},
	);
	// The stall only held ONE response; the retry streams a fresh body, so no
	// further release is needed even if the retry-start line never surfaced.
	releaseStall();

	const secondTurnCreations = stack.creations.slice(1); // everything after the turn-1 resident query
	const classified = secondTurnCreations.flatMap((c) =>
		c.payloads.map((message) => ({ path: c.path, lineage: c.lineage, forked: c.forked, resumeAt: c.resumeAt, ...classifyPayload(message) })),
	);
	const continuity = events(second.stdout, "claude_sdk_oauth_session_continuity").map((e) => e.details ?? e);
	const retries = events(second.stdout, "auto_retry_start").length;
	// The decisive signals (issue #723): after the stall, every continuity
	// decision resumes lineage (fork|delta|reattach) carrying ONLY the turn's own
	// message (deltaMessages === 1); a flatten/bootstrap or a larger delta means
	// the retry re-billed the conversation.
	const noColdSeedAfterStall = continuity.every((o) => o.kind !== "flatten" && o.kind !== "bootstrap");
	const deltaOnlyAfterStall = continuity.length > 0 && continuity.every((o) => o.deltaMessages === 1);
	const resumedWithFork = continuity.some((o) => o.kind === "fork" || o.kind === "reattach");
	const noFlattenPayload = classified.every((p) => p.kind !== "flatten");

	const passed =
		second.code === 0 &&
		retries >= 1 &&
		resumedWithFork &&
		noColdSeedAfterStall &&
		deltaOnlyAfterStall &&
		noFlattenPayload;

	summary = {
		passed,
		turn2: { code: second.code, retries, continuity },
		classified,
		providerRequests: stack.providerRequests.length,
		resumedWithFork,
		noColdSeedAfterStall,
		deltaOnlyAfterStall,
		stderr: safeDetail(second.stderr.split("\n").filter(Boolean).slice(-6).join("\n")),
	};
} catch (error) {
	summary = { passed: false, error: safeDetail(error instanceof Error ? error.stack : String(error)) };
} finally {
	if (stack) {
		await stack.shutdown().catch(() => {});
		stack.authGuard.assertUnchanged();
		stack.box.cleanup();
		cleanup.push("loopback server closed", "sandbox removed", "real auth unchanged");
	}
}

if (evidenceSlug) {
	const directory = join(
		process.cwd(),
		"local-ignore",
		"qa-evidence",
		`${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${evidenceSlug}`,
	);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "probe-resume.json"), `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(
		join(directory, "probe-resume.log"),
		`command: node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-stream-stall-retry-probe.mjs --evidence ${evidenceSlug}\n` +
			`cleanup: ${cleanup.join("; ")}\n\n${JSON.stringify(summary, null, 2)}\n`,
	);
	process.stdout.write(`EVIDENCE ${join(directory, "probe-resume.log")}\n`);
}
const finalPassed = summary?.passed === true;
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.stdout.write(finalPassed ? "VERDICT: PASS claude-sdk-oauth stream-stall retry continuity\n" : "VERDICT: FAIL claude-sdk-oauth stream-stall retry continuity\n");
process.exitCode = finalPassed ? 0 : 1;
