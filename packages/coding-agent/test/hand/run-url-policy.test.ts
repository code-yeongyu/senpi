// senpi#5645 (S40 PR 2, design v2.7): a local url in a url slot is a filesystem path under the hand's policy, not a free
// string: ls-remote reads it, push writes it, and the policy decides; a remote url never reaches the policy.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceFileError } from "@earendil-works/pi-agent-core";
import { afterAll, describe, expect, it } from "vitest";
import type { HandFileGuards } from "../../src/modes/rpc/hand-file-ops.ts";
import { planRun } from "../../src/modes/rpc/hand-run-allowlist.ts";
import { runOnHand } from "../../src/modes/rpc/hand-run-ops.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-run-url-")));
const repo = join(root, "repo");
const mirror = join(root, "mirror.git");
mkdirSync(repo);
execFileSync("git", ["init", "-q", "--template=", repo]);
execFileSync("git", ["init", "-q", "--bare", "--template=", mirror]);
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Asked {
	readonly operation: string;
	readonly canonicalPath: string;
}

function guards(
	allow: (asked: Asked) => boolean,
	asked: Asked[],
	commands: string[],
	deny: (command: string) => boolean,
): HandFileGuards {
	return {
		beforeToolCall: async (_tool, _id, input) => {
			const command = String(input.command);
			commands.push(command);
			return deny(command) ? { block: true, reason: "handler says no" } : undefined;
		},
		filesystemPolicy: () => async (request) => {
			asked.push({ operation: request.operation, canonicalPath: request.canonicalPath });
			return allow(request) ? { allow: true } : { allow: false, reason: "policy says no" };
		},
	};
}

const context = { uid: process.getuid?.() ?? 0, platform: process.platform, ownEnv: process.env };

async function runIn(
	cwd: string,
	argv: readonly string[],
	allow: (asked: Asked) => boolean,
	deny: (command: string) => boolean = () => false,
): Promise<{
	result: string;
	asked: Asked[];
	commands: string[];
	message: string;
	code: number | null;
	stderr: string;
}> {
	const asked: Asked[] = [];
	const commands: string[] = [];
	try {
		const outcome = await runOnHand(
			{ exe: "git", argv, cwd, env: {} },
			{ root, guards: guards(allow, asked, commands, deny), context, flock: undefined },
			new AbortController().signal,
		);
		return { result: "ran", asked, commands, message: "", code: outcome.code, stderr: outcome.stderr };
	} catch (error) {
		if (error instanceof DeviceFileError)
			return { result: error.code, asked, commands, message: error.message, code: null, stderr: "" };
		throw error;
	}
}

const run = (argv: readonly string[], allow: (asked: Asked) => boolean, deny?: (command: string) => boolean) =>
	runIn(repo, argv, allow, deny);

/** A fresh working repository with one commit on main, inside the scope root, to push from. */
function committed(): string {
	const dir = join(root, `src-${crypto.randomUUID()}`);
	execFileSync("git", ["init", "-q", "--template=", "-b", "main", dir]);
	writeFileSync(join(dir, "a.txt"), "a\n");
	const identity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
	execFileSync("git", ["-C", dir, "add", "a.txt"]);
	execFileSync("git", ["-C", dir, ...identity, "commit", "-q", "-m", "a"]);
	return dir;
}

function bare(name: string): string {
	const dir = join(root, name);
	execFileSync("git", ["init", "-q", "--bare", "--template=", dir]);
	mkdirSync(join(dir, "hooks"), { recursive: true });
	return dir;
}

function nested(entry: string): string {
	const dir = bare(`nested-${entry.replace(/\//g, "-")}.git`);
	const target = join(root, `elsewhere-${entry.replace(/\//g, "-")}`);
	mkdirSync(target, { recursive: true });
	rmSync(join(dir, entry), { recursive: true, force: true });
	symlinkSync(target, join(dir, entry));
	return `file://${dir}`;
}

const isRepoDir = (asked: Asked): boolean => asked.canonicalPath === realpathSync(repo);

describe.skipIf(process.platform === "win32")("a local url is a path under the hand's policy (senpi#5645)", () => {
	it("refuses ls-remote file:///etc outright: git would enter no repository there, so the policy is never asked", async () => {
		const { result, asked } = await run(["ls-remote", "file:///etc", "refs/heads/main"], () => true);
		expect(result).toBe("refused_by_policy");
		expect(asked.filter((a) => !isRepoDir(a))).toEqual([]);
	});
	it("lets ls-remote reach a local mirror when the policy permits the read", async () => {
		const { result, asked } = await run(["ls-remote", `file://${mirror}`, "refs/heads/main"], () => true);
		expect(result).toBe("ran");
		expect(asked.filter((a) => !isRepoDir(a))).toEqual([{ operation: "read", canonicalPath: realpathSync(mirror) }]);
	});

	it("judges a push to a local repo outside the worktree as a WRITE, and refuses it when the policy denies", async () => {
		const { result, asked } = await run(["push", "--quiet", `file://${mirror}`, "main:main"], (a) => isRepoDir(a));
		expect(result).toBe("refused_by_policy");
		expect(asked.filter((a) => !isRepoDir(a))).toEqual([{ operation: "write", canonicalPath: realpathSync(mirror) }]);
	});

	it("never asks the policy about a remote url, and still refuses an ext:: transport", async () => {
		const remote = await run(["ls-remote", "https://example.invalid/r", "refs/heads/main"], () => true);
		const ext = await run(["ls-remote", "ext::sh -c touch% /tmp/x", "refs/heads/main"], () => true);
		expect(remote.asked.filter((a) => !isRepoDir(a))).toEqual([]);
		expect(ext.result).toBe("refused_by_policy");
	});
	it.each([
		{
			name: "a commondir redirect",
			url: () => {
				const dir = join(root, "common");
				execFileSync("git", ["init", "-q", "--bare", "--template=", dir]);
				writeFileSync(join(dir, "commondir"), `${mirror}\n`);
				return `file://${dir}`;
			},
		},
		{
			name: "a gitfile (then a commondir)",
			url: () => {
				const target = join(root, "gitfile-target");
				execFileSync("git", ["init", "-q", "--bare", "--template=", target]);
				writeFileSync(join(target, "commondir"), `${mirror}\n`);
				mkdirSync(join(root, "gitfile"));
				writeFileSync(join(root, "gitfile", ".git"), `gitdir: ${target}\n`);
				return `file://${join(root, "gitfile")}`;
			},
		},
		{
			name: "objects/info/alternates",
			url: () => {
				const dir = join(root, "alternates");
				execFileSync("git", ["init", "-q", "--bare", "--template=", dir]);
				mkdirSync(join(dir, "objects", "info"), { recursive: true });
				writeFileSync(join(dir, "objects", "info", "alternates"), `${join(mirror, "objects")}\n`);
				return `file://${dir}`;
			},
		},
		{
			name: "the repository path itself as a symlink",
			url: () => {
				symlinkSync(mirror, join(root, "self-link.git"));
				return `file://${join(root, "self-link.git")}`;
			},
		},
		{
			name: "a P.git variant",
			url: () => {
				mkdirSync(join(root, "variant"));
				execFileSync("git", ["init", "-q", "--bare", "--template=", join(root, "variant.git")]);
				return `file://${join(root, "variant")}`;
			},
		},
	])("refuses $name (local_repo_shape_unsupported) without asking the policy", async ({ url }) => {
		const target = url();
		const read = await run(["ls-remote", target, "refs/heads/main"], () => true);
		const write = await run(["push", "--quiet", target, "main:main"], () => true);
		expect([read.result, write.result]).toEqual(["refused_by_policy", "refused_by_policy"]);
		expect([...read.asked, ...write.asked].filter((a) => !isRepoDir(a))).toEqual([]);
	});

	it("allows a mirror under a symlinked ancestor when the policy permits, judging its real path", async () => {
		symlinkSync(root, join(root, "ancestor"));
		const { result, asked } = await run(
			["ls-remote", `file://${join(root, "ancestor", "mirror.git")}`, "refs/heads/main"],
			() => true,
		);
		expect(result).toBe("ran");
		expect(asked.filter((a) => !isRepoDir(a))).toEqual([{ operation: "read", canonicalPath: realpathSync(mirror) }]);
	});

	it("refuses a local url that names no repository", async () => {
		const { result, asked } = await run(
			["ls-remote", `file://${join(root, "nothing")}`, "refs/heads/main"],
			() => true,
		);
		expect(result).toBe("refused_by_policy");
		expect(asked.filter((a) => !isRepoDir(a))).toEqual([]);
	});

	it("classifies urls as git does: a malformed %-escape is a typed refusal, and 1host:path is ssh", () => {
		const plan = (url: string) =>
			planRun({ exe: "git", argv: ["ls-remote", url, "refs/heads/main"], env: {} }, context);
		const malformed = { ok: false };
		const scp = plan("1host:path");
		const local = plan("./mirror.git");
		expect([malformed.ok, scp.ok && scp.paths.length, local.ok && local.paths.map((p) => p.kind)]).toEqual([
			false,
			0,
			["source"],
		]);
	});
	it.each([
		{
			name: "'..' after a symlink",
			url: () => {
				symlinkSync(join(root, "repo"), join(root, "dotdot-link"));
				return `file://${join(root, "dotdot-link")}/../mirror.git`;
			},
		},
		{ name: "a leading '~/'", url: () => "~/mirror.git" },
		{ name: "a relative path", url: () => "./mirror.git" },
		{ name: "a malformed %-escape", url: () => "file:///%zz" },
		{ name: "a nested symlink at refs/heads", url: () => nested("refs/heads") },
		{ name: "a nested symlink at objects/pack", url: () => nested("objects/pack") },
		{ name: "a symlinked packed-refs", url: () => nested("packed-refs") },
		{ name: "a symlinked worktrees/", url: () => nested("worktrees") },
		{
			name: "a symlinked reflog file",
			url: () => {
				const dir = bare("reflog.git");
				mkdirSync(join(dir, "logs", "refs", "heads"), { recursive: true });
				writeFileSync(join(root, "reflog-victim"), "");
				symlinkSync(join(root, "reflog-victim"), join(dir, "logs", "refs", "heads", "main"));
				return `file://${dir}`;
			},
		},
	])("refuses $name for read and write without asking the policy", async ({ url }) => {
		const target = url();
		const read = await run(["ls-remote", target, "refs/heads/main"], () => true);
		const write = await run(["push", "--quiet", target, "main:main"], () => true);
		expect([read.result, write.result]).toEqual(["refused_by_policy", "refused_by_policy"]);
		expect([...read.asked, ...write.asked].filter((a) => !isRepoDir(a))).toEqual([]);
	});

	it("never runs a local target's hooks on a push: the hardened receive-pack sets core.hooksPath=/dev/null", async () => {
		const dir = bare("hooked.git");
		const marker = join(root, "hook-ran");
		writeFileSync(join(dir, "hooks", "post-receive"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
		const pushed = await runIn(committed(), ["push", "--quiet", `file://${dir}`, "main:main"], () => true);
		expect([pushed.result, pushed.code, existsSync(marker)]).toEqual(["ran", 0, false]);
	});

	it.each([
		{ name: "core.hooksPath", set: ["core.hooksPath", "/tmp"] },
		{ name: "include.path", set: ["include.path", "/tmp/elsewhere.cfg"] },
		{ name: "filter.x.smudge", set: ["filter.x.smudge", "touch /tmp/x"] },
		{ name: "receive.denyCurrentBranch", set: ["receive.denyCurrentBranch", "updateInstead"] },
		{ name: "extensions.worktreeConfig", set: ["extensions.worktreeConfig", "true"] },
	])("refuses a target whose config sets $name (not allowlisted), without asking the policy", async ({ set }) => {
		const dir = bare(`cfg-${set[0]?.replace(/\./g, "-")}.git`);
		execFileSync("git", ["config", "--file", join(dir, "config"), ...set]);
		const read = await run(["ls-remote", `file://${dir}`, "refs/heads/main"], () => true);
		const write = await run(["push", "--quiet", `file://${dir}`, "main:main"], () => true);
		expect([read.result, write.result, write.message.includes("not allowlisted")]).toEqual([
			"refused_by_policy",
			"refused_by_policy",
			true,
		]);
		expect([...read.asked, ...write.asked].filter((a) => !isRepoDir(a))).toEqual([]);
	});

	it.each([
		{
			name: "a clone --bare",
			make: (dir: string) => execFileSync("git", ["clone", "-q", "--bare", mirror, dir]),
			gitDir: (dir: string) => dir,
		},
		{
			name: "a clone --mirror",
			make: (dir: string) => execFileSync("git", ["clone", "-q", "--mirror", mirror, dir]),
			gitDir: (dir: string) => dir,
		},
		{
			name: "a working clone",
			make: (dir: string) => execFileSync("git", ["clone", "-q", mirror, dir]),
			gitDir: (dir: string) => join(dir, ".git"),
		},
	])("allows $name target when the policy permits, judging its git dir", async ({ make, gitDir }) => {
		const dir = join(root, `allowed-${crypto.randomUUID()}`);
		make(dir);
		const { result, asked } = await run(["ls-remote", `file://${dir}`, "refs/heads/main"], () => true);
		expect([result, asked.filter((a) => !isRepoDir(a))]).toEqual([
			"ran",
			[{ operation: "read", canonicalPath: realpathSync(gitDir(dir)) }],
		]);
	});

	it("refuses a local run when the effective config carries any url.* rewrite (local_url_rewritten)", async () => {
		execFileSync("git", ["-C", repo, "config", "url.file:///nowhere.insteadOf", `file://${mirror}`]);
		try {
			const { result, message, asked } = await run(["ls-remote", `file://${mirror}`, "refs/heads/main"], () => true);
			expect([result, message.includes("local_url_rewritten"), asked.filter((a) => !isRepoDir(a))]).toEqual([
				"refused_by_policy",
				true,
				[],
			]);
		} finally {
			execFileSync("git", ["-C", repo, "config", "--unset-all", "url.file:///nowhere.insteadOf"]);
		}
	});

	it("lets git itself refuse a remote url that a rewrite turns local (protocol.file.allow=never)", async () => {
		execFileSync("git", ["-C", repo, "config", `url.file://${mirror}.insteadOf`, "ssh://example.invalid/r"]);
		try {
			const outcome = await run(["ls-remote", "ssh://example.invalid/r", "refs/heads/main"], () => true);
			expect([outcome.result, outcome.code !== 0, /transport 'file' not allowed/.test(outcome.stderr)]).toEqual([
				"ran",
				true,
				true,
			]);
		} finally {
			execFileSync("git", ["-C", repo, "config", "--unset-all", `url.file://${mirror}.insteadOf`]);
		}
	});

	it("classifies spellings exactly as git does on POSIX", () => {
		const plan = (url: string) =>
			planRun({ exe: "git", argv: ["ls-remote", url, "refs/heads/main"], env: {} }, context);
		const kinds = (url: string) => {
			const planned = plan(url);
			return planned.ok ? planned.paths.map((p) => p.kind).join("") || "remote" : "refused";
		};
		expect(["file://otherhost/x", "file:x", "FILE:///x", "1host:path", "./x"].map(kinds)).toEqual([
			"source",
			"remote",
			"refused",
			"remote",
			"source",
		]);
	});
});
