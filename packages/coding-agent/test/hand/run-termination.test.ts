// senpi#7282: the hand reports why a `run` ended. A child its own timer stopped is `timed_out`; a child that ends on
// the same SIGTERM for another reason is `signaled`. A stub `git` on the hand's PATH stands in for a hung and a
// self-signalled git, so neither case depends on what a real git does.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HandFileGuards } from "../../src/modes/rpc/hand-file-ops.ts";
import { runOnHand } from "../../src/modes/rpc/hand-run-ops.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-run-termination-")));
const bin = join(root, "bin");
const repo = join(root, "repo");
const markers = join(root, "markers");
mkdirSync(bin);
mkdirSync(repo);
mkdirSync(markers);
writeFileSync(
	join(bin, "git"),
	[
		"#!/bin/sh",
		'for arg in "$@"; do',
		'  case "$arg" in',
		'    --version) echo "git version 2.50.0"; exit 0 ;;',
		"    --git-common-dir) exec sleep 600 ;;",
		'    --verify) kill -TERM "$$"; exec sleep 600 ;;',
		// Survives the timer's SIGTERM and exits 0 on its own instead.
		// Records its pid, then ends on its own SIGTERM.
		`    -D) echo $$ > "${markers}/pid"; kill -TERM "$$"; exec sleep 600 ;;`,
		"    --show-current) trap 'exit 0' TERM; while :; do sleep 1; done ;;",
		"  esac",
		"done",
		"exit 0",
		"",
	].join("\n"),
);
chmodSync(join(bin, "git"), 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const guards: HandFileGuards = {
	beforeToolCall: async () => undefined,
	filesystemPolicy: () => async () => ({ allow: true }),
};

const context = {
	uid: process.getuid?.() ?? 0,
	platform: process.platform,
	ownEnv: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
};

const run = (argv: readonly string[], timeoutMs: number) =>
	runOnHand(
		{ exe: "git", argv, cwd: repo, env: {}, timeoutMs },
		{ root, guards, context, flock: undefined },
		new AbortController().signal,
	);

describe.skipIf(process.platform === "win32")("hand run termination", () => {
	it("reports timed_out when the hand's own timer stops a hung git", async () => {
		const outcome = await run(["rev-parse", "--git-common-dir"], 100);
		expect(outcome.signal).toBe("SIGTERM");
		expect(outcome.termination).toEqual({ kind: "timed_out" });
	});

	it("reports signaled for a git that ends on SIGTERM before the timer", async () => {
		const outcome = await run(["rev-parse", "--verify", "HEAD"], 60_000);
		expect(outcome.signal).toBe("SIGTERM");
		expect(outcome.termination).toEqual({ kind: "signaled" });
	});

	it("reports exited, not timed_out, for a git that survives the timer's signal and exits 0", async () => {
		const outcome = await run(["branch", "--show-current"], 1_000);
		expect(outcome.code).toBe(0);
		expect(outcome.signal).toBeNull();
		expect(outcome.termination).toEqual({ kind: "exited" });
	});

	// #7308 review: the git ends on its own SIGTERM before the deadline, but the loop is held so its exit is not yet
	// reaped when the hand's timer comes due, and kill() on that zombie succeeds. It is signaled, not timed_out.
	it.skipIf(process.platform !== "linux")(
		"reports signaled for a git that ended on its own SIGTERM but was not yet reaped at the deadline",
		async () => {
			const timeoutMs = 1_000;
			const watcher = watch(markers, () => {
				watcher.close();
				const pid = readFileSync(join(markers, "pid"), "utf8").trim();
				const ready = Date.now() + timeoutMs + 200;
				const giveUp = Date.now() + 10_000;
				while (Date.now() < ready || !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ")) {
					if (Date.now() > giveUp) throw new Error(`git ${pid} never became an unreaped zombie`);
				}
			});
			try {
				const outcome = await run(["branch", "-D", "topic"], timeoutMs);
				expect(outcome.signal).toBe("SIGTERM");
				expect(outcome.termination).toEqual({ kind: "signaled" });
			} finally {
				watcher.close();
			}
		},
	);

	it("reports exited for a git that exits on its own", async () => {
		const outcome = await run(["status", "--porcelain"], 60_000);
		expect(outcome.code).toBe(0);
		expect(outcome.termination).toEqual({ kind: "exited" });
	});
});
