// senpi#5645 (S40 PR 2, design v2.2-v2.4): the `run` operation reaches only the git and lsof calls the memory component
// makes. Each accepted row is one of its real call shapes; each refused row is a way out of that set, including the two
// code-execution chains the design review demonstrated (config core.sshCommand then ls-remote; core.hooksPath then
// commit), which are refused at their first step.
import { describe, expect, it } from "vitest";
import { planRun, renderCommand } from "../../src/modes/rpc/hand-run-allowlist.ts";

const hand = {
	uid: 501,
	platform: "darwin" as const,
	ownEnv: { PATH: "/usr/bin", HOME: "/home/h", SSH_AUTH_SOCK: "/s" },
};
const plan = (exe: string, argv: string[], env: Record<string, string> = {}) => planRun({ exe, argv, env }, hand);
const PREFIX = ["-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];

describe("the run allowlist accepts every call shape the memory component makes (senpi#5645)", () => {
	it.each([
		["init", ["init", "--template="]],
		["prune-packed", ["prune-packed", "--quiet"]],
		["maintenance", ["maintenance", "run", "--task=loose-objects", "--quiet"]],
		["config get", ["config", "--local", "--get", "omo.agentId"]],
		["config set", ["config", "--local", "user.name", "Someone"]],
		["config unset", ["config", "--local", "--unset-all", "omo.sync.binding"]],
		["config key case", ["config", "--local", "--get", "USER.EMAIL"]],
		["log with a -c key", ["-c", "log.showRoot=false", "log", "--format=%H"]],
		["literal pathspecs", ["--literal-pathspecs", "ls-files", "--", "a b.md"]],
		["remote", ["remote", "-v"]],
		["ls-remote file", ["ls-remote", "file:///tmp/bare.git"]],
		["commit-tree", ["commit-tree", "-F", "-", "abc"]],
	])("accepts %s", (_label, argv) => {
		const result = plan("git", argv);

		expect(result).toMatchObject({ ok: true, exe: "git", argv: [...PREFIX, ...argv] });
	});

	it("carries the identity keys and the hand's own baseline, nothing else", () => {
		const result = plan("git", ["commit-tree", "-F", "-", "abc"], {
			GIT_AUTHOR_NAME: "A",
			GIT_AUTHOR_EMAIL: "a@x",
			GIT_COMMITTER_NAME: "C",
			GIT_COMMITTER_EMAIL: "c@x",
			GIT_TERMINAL_PROMPT: "0",
		});

		expect(result).toMatchObject({
			ok: true,
			env: {
				PATH: "/usr/bin",
				HOME: "/home/h",
				SSH_AUTH_SOCK: "/s",
				LANG: "C",
				GIT_PROTOCOL_FROM_USER: "0",
				GIT_AUTHOR_NAME: "A",
				GIT_COMMITTER_EMAIL: "c@x",
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	});

	it.each([
		["holders of one file", ["-t", "--", "/m/a.md"]],
		["repository in use", ["-w", "-a", "-d", "cwd", "-u", "501", "-Fpn"]],
	])("accepts lsof: %s", (_label, argv) => {
		expect(plan("lsof", argv)).toMatchObject({ ok: true, exe: "lsof", argv });
	});
});

describe("the run allowlist refuses everything else (senpi#5645)", () => {
	it.each([
		["a shell", "sh", ["-c", "true"]],
		["chain T6 step 1: config core.sshCommand", "git", ["config", "core.sshCommand", "x"]],
		["chain T6 step 1, local", "git", ["config", "--local", "core.sshCommand", "touch x"]],
		["chain T9 step 1: config core.hooksPath", "git", ["config", "--local", "core.hooksPath", "/tmp/h"]],
		["config --file", "git", ["config", "--file", "/tmp/x", "a.b", "c"]],
		["config --global", "git", ["config", "--global", "user.name", "x"]],
		["config include.path", "git", ["config", "--local", "include.path", "/tmp/x"]],
		["a -c key outside the nine", "git", ["-c", "core.sshCommand=x", "ls-remote", "u"]],
		["the hand's own key from the caller", "git", ["-c", "core.fsmonitor=true", "status"]],
		["--exec-path", "git", ["--exec-path=/tmp", "rev-parse", "HEAD"]],
		["--upload-pack", "git", ["ls-remote", "--upload-pack=x", "u"]],
		["--receive-pack", "git", ["push", "--receive-pack", "x", "u"]],
		["ext:: url", "git", ["ls-remote", "ext::sh -c x"]],
		["fd:: url", "git", ["ls-remote", "fd::3"]],
		["maintenance start", "git", ["maintenance", "start"]],
		["remote add", "git", ["remote", "add", "x", "u"]],
		["init with a template", "git", ["init", "--template=/tmp/t"]],
		["init with a split template", "git", ["init", "--template", "/tmp/t"]],
		["-C", "git", ["-C", "/tmp", "status"]],
		["a subcommand outside the set", "git", ["clone", "u"]],
		["-c after the subcommand", "git", ["log", "-c", "x"]],
		["lsof another shape", "lsof", ["-F", "--", "p"]],
		["lsof another uid", "lsof", ["-w", "-a", "-d", "cwd", "-u", "0", "-Fpn"]],
	])("refuses %s", (_label, exe, argv) => {
		expect(plan(exe, argv)).toMatchObject({ ok: false });
	});

	it.each([
		["an unknown key", { GIT_DIR: "/tmp" }],
		["a prompt other than 0", { GIT_TERMINAL_PROMPT: "1" }],
		["glob pathspecs other than 0/1", { GIT_GLOB_PATHSPECS: "yes" }],
		["a dropped pathspec key", { GIT_LITERAL_PATHSPECS: "1" }],
		["the protocol key", { GIT_PROTOCOL_FROM_USER: "1" }],
	])("refuses an env with %s", (_label, env) => {
		expect(plan("git", ["status"], env)).toMatchObject({ ok: false });
	});
});

describe("the handlers see exactly the command that runs (senpi#5645)", () => {
	it("renders the final argv POSIX-quoted, so an argument with spaces stays one argument", () => {
		const result = plan("git", ["--literal-pathspecs", "ls-files", "--", "a b.md; rm -rf x"]);
		if (!result.ok) throw new Error(result.reason);

		expect(renderCommand(result.exe, result.argv)).toBe(
			"git -c core.fsmonitor=false -c protocol.file.allow=always --literal-pathspecs ls-files -- 'a b.md; rm -rf x'",
		);
	});
});
