// senpi#5645 (S40 PR 2, design v2.7): a local url in a url slot is a filesystem path under the hand's policy, not a free
// string: ls-remote reads it, push writes it, and the policy decides; a remote url never reaches the policy.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function guards(allow: (asked: Asked) => boolean, asked: Asked[]): HandFileGuards {
	return {
		beforeToolCall: async () => undefined,
		filesystemPolicy: () => async (request) => {
			asked.push({ operation: request.operation, canonicalPath: request.canonicalPath });
			return allow(request) ? { allow: true } : { allow: false, reason: "policy says no" };
		},
	};
}

const context = { uid: process.getuid?.() ?? 0, platform: process.platform, ownEnv: process.env };

async function run(
	argv: readonly string[],
	allow: (asked: Asked) => boolean,
): Promise<{ result: string; asked: Asked[] }> {
	const asked: Asked[] = [];
	try {
		await runOnHand(
			{ exe: "git", argv, cwd: repo, env: {} },
			{ root, guards: guards(allow, asked), context, flock: undefined },
			new AbortController().signal,
		);
		return { result: "ran", asked };
	} catch (error) {
		if (error instanceof DeviceFileError) return { result: error.code, asked };
		throw error;
	}
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
		const malformed = plan("file:///%zz");
		const scp = plan("1host:path");
		const local = plan("./mirror.git");
		expect([malformed.ok, scp.ok && scp.paths.length, local.ok && local.paths.map((p) => p.kind)]).toEqual([
			false,
			0,
			["source"],
		]);
	});
});
