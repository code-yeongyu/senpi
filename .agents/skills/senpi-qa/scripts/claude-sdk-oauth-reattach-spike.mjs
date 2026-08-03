#!/usr/bin/env node
/**
 * Live spike: re-attach mechanisms for the claude-sdk-oauth lane (Wave A todo 3).
 *
 * (a) resume-after-process-exit: a CHILD process owns query A (2 turns) and then
 *     exits entirely; the parent opens a new query with `resume: <same id>`,
 *     asserts coherence, and reports cache_read_input_tokens vs total prompt
 *     tokens on the resumed turn.
 * (b) cross-account resume: the resumed query authenticates as a DIFFERENT
 *     seeded sandbox slot under the SAME config root.
 * (c) config-root addressing: a session is seeded INTO a non-default root
 *     (CLAUDE_CONFIG_DIR=<scoped root> on the seeding child), then
 *     getSessionInfo/getSessionMessages + a resume run from a second child
 *     under the SAME scoped root, plus a static-only read under the default
 *     root. env-honored requires "visible under the scoped root AND absent
 *     from the default root"; visible under the default root means the SDK
 *     ignored CLAUDE_CONFIG_DIR (default-only). Seeding into the scoped root
 *     first is what makes env-honored reachable — probing a default-root
 *     session from an empty scoped root could only ever fail.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-reattach-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED resume=<ok> cache_read_ratio=<r> cross_account=<ok|denied|incoherent|lineage_mismatch|unseeded> config_root=<env-honored|default-only>"
 *   exit 2 "REJECTED signal=<sanitized>"   (e.g. resume_not_found)
 * cross_account is `unseeded` — never `ok` — when no distinct second account slot
 * (claude-sdk-oauth-spike-b) was seeded, so an untested arm cannot read as proven;
 * it is `denied` only when the resume itself errors — a model recall miss on a
 * successful resume is `incoherent`, never folded into the security verdict.
 * Never prints token material.
 */
import { execFileSync, fork } from "node:child_process";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadCredential,
	loadCredentialStrict,
	reject,
	requireLiveGate,
	requireSandbox,
	safeSignal,
	withTimeout,
} from "./lib/claude-sdk-oauth-spike-support.mjs";
import { runTurns, TOKEN_PROMPT } from "./lib/claude-sdk-oauth-reattach-worker.mjs";

const WORKER_FLAG = "--reattach-worker";
const SELF = fileURLToPath(import.meta.url);

if (process.argv.includes(WORKER_FLAG)) {
	// The request carries an OAuth access token, so it arrives over the IPC channel
	// rather than the environment: env is inherited by the Claude Code subprocess
	// this worker spawns, which would put the token in that process's environment.
	// The exit hook is the last-resort grandchild reap: a worker dying by any
	// path (including a hard crash) closes its query handle so the Claude Code
	// subprocess cannot outlive it. The worker's own 210s turn timeout bounds
	// the grandchild even in the worst case.
	let activeStream;
	process.once("exit", () => {
		closeQuietly(activeStream);
	});
	const request = await new Promise((resolve) => process.once("message", resolve));
	const result = await runTurns(request, (stream) => {
		activeStream = stream;
	}).catch((error) => ({
		error: error instanceof Error ? error.message : String(error),
	}));
	process.send?.(result, () => process.exit(0));
} else {
	requireLiveGate();
	const sandbox = requireSandbox();
	const primary = loadCredential(sandbox);
	if (primary.error) reject(primary.error);
	// STRICT: the forgiving loader falls back to the primary slot, which would let
	// the cross-account arm report `ok` without ever using a second account.
	const secondary = loadCredentialStrict(sandbox, "claude-sdk-oauth-spike-b");
	const token = `REATTACH_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
	// Every reject path that can carry an SDK/worker error string redacts the
	// access token and the generated recall token first — safeSignal is a shape
	// sanitizer, not a secret redactor.
	const secrets = [primary.credential.access, token];
	// The secondary account's token must be redacted too — a cross-account SDK
	// error string could otherwise echo it into the REJECTED line.
	if (!secondary.error) secrets.push(secondary.credential.access);

	const activeChildren = new Set();
	const scopedRoots = new Set();
	// Signal-aware cleanup: an interrupted spike must take every live worker
	// (and its Claude Code grandchild) down and remove temp config roots BEFORE
	// exiting — a detached child outliving the parent keeps burning quota.
	// SIGHUP is included: a closed terminal would otherwise orphan the detached
	// worker and its grandchild.
	const cleanupRuntime = () => {
		for (const child of activeChildren) terminateChild(child);
		for (const root of scopedRoots) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
		}
	};
	process.once("exit", cleanupRuntime);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.once(signal, () => {
			cleanupRuntime();
			reject(`interrupted_${signal.toLowerCase()}`);
		});
	}

	// Every worker runs with an isolated HOME/USERPROFILE: when the SDK
	// ignores CLAUDE_CONFIG_DIR (the default-only outcome), the seeded session
	// must land in a THROWAWAY default root — never the operator's real
	// ~/.claude — and the default-root control read must measure that same
	// isolated root.
	const sandboxHome = mkdtempSync(join(tmpdir(), "claude-sdk-oauth-home-"));
	scopedRoots.add(sandboxHome);

	const runChild = (request) => {
		let child;
		const run = new Promise((resolve, rejectRun) => {
			// detached: the worker gets its own process group so a timeout can
			// take its Claude Code grandchild down with it instead of orphaning
			// the grandchild to keep burning subscription quota.
			child = fork(SELF, [WORKER_FLAG], {
				silent: true,
				detached: process.platform !== "win32",
				env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
			});
			activeChildren.add(child);
			child.send(request);
			let received;
			child.once("message", (message) => {
				received = message;
			});
			child.once("error", rejectRun);
			child.once("exit", (code, signal) =>
				received ? resolve(received) : rejectRun(new Error(`worker_${signal ?? code ?? "exit"}`)),
			);
		});
		return withTimeout(run, "worker", 240_000).finally(() => {
			activeChildren.delete(child);
			terminateChild(child);
		});
	};

	try {
		await main(runChild, primary, secondary, token, scopedRoots, secrets);
	} catch (error) {
		// Spawn/IPC failures and worker timeouts must surface through the same
		// sanitized REJECTED contract as in-spike failures, never a raw exit 1.
		reject(error instanceof Error ? error.message : String(error), "", secrets);
	}
}

/** Kill a timed-out/failed worker AND its Claude Code grandchild (process group on POSIX, process tree on Windows). */
function terminateChild(child) {
	if (!child || child.pid === undefined) return;
	try {
		if (process.platform === "win32") {
			// child.kill() cannot reach the grandchild on Windows — there is no
			// process group to signal — so take the whole tree down instead.
			// taskkill on an exited worker fails harmlessly into the catch.
			execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			// Group-kill even when the worker already exited: a grandchild in the
			// detached group can outlive the worker, and an exited group leader
			// leaves the group addressable until the last member dies.
			process.kill(-child.pid, "SIGKILL");
		}
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}

async function main(runChild, primary, secondary, token, scopedRoots, secrets) {
	// (a) seed the session in a child process, then let that process die.
	const seeded = await runChild({
		access: primary.credential.access,
		prompts: [TOKEN_PROMPT(token), "Reply with exactly: SECOND"],
	});
	if (seeded.error) reject(seeded.error, "", secrets);
	if (!seeded.sessionId) reject("session_id_absent");

	// (a) resume the dead session from this process.
	const resumed = await runChild({
		access: primary.credential.access,
		resume: seeded.sessionId,
		prompts: ["Repeat the token I gave you at the start, prefixed with RECALL."],
		expectToken: token,
	});
	if (resumed.error) reject(resumed.error === "resume_failed" ? "resume_not_found" : resumed.error, "", secrets);
	if (!resumed.coherent) reject("resume_incoherent");
	// The resumed query must report the SEEDED session id — a new or different
	// lineage cannot pass on model text alone.
	if (resumed.sessionId !== seeded.sessionId) reject("resume_lineage_mismatch");
	const cacheRead = resumed.usage?.cacheRead ?? 0;
	const promptTokens = Math.max(1, (resumed.usage?.input ?? 0) + cacheRead + (resumed.usage?.cacheCreation ?? 0));
	const ratio = (cacheRead / promptTokens).toFixed(2);

	// (b) cross-account resume under the same config root. Without a genuinely
	// distinct slot B the arm is reported as `unseeded` — never as `ok` — so a
	// missing second account can never be mistaken for a proven capability.
	let crossAccount = "unseeded";
	if (secondary.error) {
		if (!secondary.error.startsWith("slot_missing_")) reject(secondary.error);
	} else if (secondary.credential.access === primary.credential.access) {
		reject("cross_account_slots_identical");
	} else {
		const crossed = await runChild({
			access: secondary.credential.access,
			resume: seeded.sessionId,
			prompts: ["Repeat the token I gave you at the start, prefixed with RECALL."],
			expectToken: token,
		});
		// `denied` is the security verdict and is reserved for known resume/auth
		// failures; infrastructure failures (worker spawn/IPC/timeout) and other
		// turn-level errors reject the spike instead of masquerading as a denial.
		const denial = crossed.error === "resume_failed" || crossed.error === "authentication_failed";
		if (crossed.error && !denial) reject(crossed.error, "", secrets);
		// A successful resume whose model simply misses the recall is inconclusive
		// evidence about cross-account addressing, not a denial. And ok requires
		// the SAME lineage: a cross-account resume that silently became a fresh
		// session proves neither denial nor continuity.
		crossAccount = crossed.error
			? "denied"
			: crossed.sessionId !== seeded.sessionId
				? "lineage_mismatch"
				: crossed.coherent
					? "ok"
					: "incoherent";
	}

	// (c) config-root addressing: seed INTO the scoped root, then check both
	// roots. The default-root read is static-only (no Claude Code spawn).
	const scopedRoot = mkdtempSync(join(tmpdir(), "claude-sdk-oauth-config-root-"));
	scopedRoots.add(scopedRoot);
	const scopedSeed = await runChild({
		access: primary.credential.access,
		configDir: scopedRoot,
		prompts: [TOKEN_PROMPT(token)],
	});
	if (scopedSeed.error) reject(scopedSeed.error, "", secrets);
	if (!scopedSeed.sessionId) reject("session_id_absent");
	const defaultRead = await runChild({
		access: primary.credential.access,
		staticRead: scopedSeed.sessionId,
		staticOnly: true,
	});
	if (defaultRead.error) reject(defaultRead.error, "", secrets);
	// A static-read FAILURE is infrastructure, not evidence of absence.
	if (defaultRead.staticError) reject(defaultRead.staticError, "", secrets);
	const scoped = await runChild({
		access: primary.credential.access,
		configDir: scopedRoot,
		staticRead: scopedSeed.sessionId,
		resume: scopedSeed.sessionId,
		prompts: ["Repeat the token I gave you at the start, prefixed with RECALL."],
		expectToken: token,
	});
	// A static-read FAILURE is infrastructure, not evidence of absence.
	if (scoped.staticError) reject(scoped.staticError, "", secrets);
	// Turn-level resume failures (subscription, model refusal, worker timeout)
	// are infrastructure too — only resume_failed is addressing evidence.
	if (scoped.error && scoped.error !== "resume_failed") reject(scoped.error, "", secrets);
	// A successful scoped static read followed by resume_failed is contradictory
	// evidence (visible but not resumable): reject it instead of letting it
	// collapse into config_root_unaddressable.
	if (scoped.error === "resume_failed" && scoped.staticFound === true) {
		reject("config_root_contradictory");
	}
	// staticFound is the direct visibility measurement; a model recall miss
	// would be a coherence observation, not a config-root verdict, so it stays
	// out of this gate. The resumed query must also report the SCOPED-SEEDED
	// session id — a fresh lineage proves addressing failed even when the
	// static read and the turn both succeeded.
	const scopedFound = !scoped.error && scoped.staticFound === true && scoped.sessionId === scopedSeed.sessionId;
	let configRoot;
	if (defaultRead.staticFound === true) {
		// Visible under the default root: the SDK ignored CLAUDE_CONFIG_DIR.
		configRoot = "default-only";
	} else if (scopedFound) {
		configRoot = "env-honored";
	} else {
		reject("config_root_unaddressable");
	}

	console.log(
		`ACCEPTED resume=ok cache_read_ratio=${ratio} cross_account=${safeSignal(crossAccount)} config_root=${configRoot}`,
	);
	// exitCode, not exit(): a forced exit can truncate the ACCEPTED line when
	// stdout is a pipe; assigning lets Node flush the QA output first.
	process.exitCode = 0;
}
