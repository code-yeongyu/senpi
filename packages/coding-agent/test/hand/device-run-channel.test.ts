// senpi#5645 (S40 PR 2): the `run` operation through a real hand. The memory component's git shapes run on the device;
// the first step of each demonstrated code-execution chain is refused, so the second step has nothing to run; and the
// hand's handlers judge exactly the command that runs, as `bash`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DeviceFileError, type DeviceFiles } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { cleanupHands, handDirs, openLink, remoteHost, startHand } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

async function hand(extensions: InlineExtension[] = []): Promise<{ files: DeviceFiles; cwd: string }> {
	const dirs = await handDirs("s40-run");
	const link = openLink();
	startHand(link, dirs, extensions);
	return {
		files: remoteHost(link).deviceFiles({ id: `scope-${crypto.randomUUID()}`, root: dirs.cwd }),
		cwd: dirs.cwd,
	};
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

async function code(operation: Promise<unknown>): Promise<string> {
	try {
		await operation;
		return "ran";
	} catch (error) {
		if (error instanceof DeviceFileError) return error.code;
		throw error;
	}
}

describe("the run operation on a hand (senpi#5645)", () => {
	it("runs the memory component's git shapes on the device", async () => {
		const { files, cwd } = await hand();
		const repo = join(cwd, "repo");
		await files.mkdir(repo);

		const init = await files.run({ exe: "git", argv: ["init", "--template="], cwd: repo });
		await files.run({ exe: "git", argv: ["config", "--local", "omo.agentId", "agent-1"], cwd: repo });
		const read = await files.run({ exe: "git", argv: ["config", "--local", "--get", "omo.agentId"], cwd: repo });
		const bare = join(cwd, "mirror.git");
		execFileSync("git", ["init", "--bare", "-q", bare]);
		const remote = await files.run({ exe: "git", argv: ["ls-remote", `file://${bare}`], cwd: repo });

		expect([init.code, text(read.stdout), remote.code]).toEqual([0, "agent-1", 0]);
		expect(existsSync(join(repo, ".git", "hooks", "pre-commit.sample"))).toBe(false);
	});

	it("refuses the run-channel first step of both code-execution chains (config sshCommand/hooksPath, a shell)", async () => {
		const { files, cwd } = await hand();
		const repo = join(cwd, "repo");
		await files.mkdir(repo);
		await files.run({ exe: "git", argv: ["init", "--template="], cwd: repo });
		const marker = join(cwd, "ran");

		const sshCommand = await code(
			files.run({ exe: "git", argv: ["config", "--local", "core.sshCommand", `touch ${marker}`], cwd: repo }),
		);
		const hooksPath = await code(
			files.run({ exe: "git", argv: ["config", "--local", "core.hooksPath", cwd], cwd: repo }),
		);
		const shell = await code(files.run({ exe: "sh", argv: ["-c", `touch ${marker}`], cwd: repo }));

		expect([sshCommand, hooksPath, shell]).toEqual(["refused_by_policy", "refused_by_policy", "refused_by_policy"]);
		expect(existsSync(marker)).toBe(false);
	});

	it("shows the hand's handlers the quoted command that runs, as bash", async () => {
		const commands: string[] = [];
		const recorder: InlineExtension = (pi) => {
			pi.on("tool_call", (event) => {
				if (event.toolName === "bash") commands.push(String((event.input as { command?: unknown }).command));
				return undefined;
			});
		};
		const { files, cwd } = await hand([recorder]);
		const repo = join(cwd, "repo");
		await files.mkdir(repo);
		await files.run({ exe: "git", argv: ["init", "--template="], cwd: repo });

		const listed = await files.run({
			exe: "git",
			argv: ["--literal-pathspecs", "ls-files", "--", "a b; touch x"],
			cwd: repo,
		});

		expect(listed.code).toBe(0);
		expect(commands.at(-1)).toBe(
			"git -c core.fsmonitor=false -c protocol.file.allow=always --literal-pathspecs ls-files -- 'a b; touch x'",
		);
		expect(existsSync(join(repo, "x"))).toBe(false);
	});
	it("blocks the .git/config route when a tool_call handler refuses writes under .git (the N1 hook point)", async () => {
		const noGitWrites: InlineExtension = (pi) => {
			pi.on("tool_call", (event) => {
				const path = String((event.input as { path?: unknown }).path ?? "");
				return event.toolName === "write" && path.includes("/.git/")
					? { block: true, reason: "no .git writes" }
					: undefined;
			});
		};
		const { files, cwd } = await hand([noGitWrites]);
		const repo = join(cwd, "repo");
		await files.mkdir(repo);
		await files.run({ exe: "git", argv: ["init", "--template="], cwd: repo });
		const marker = join(cwd, "ran");

		const write = await code(
			files.write(
				join(repo, ".git", "config"),
				new TextEncoder().encode(`[core]\n\tsshCommand = touch ${marker}\n`),
			),
		);
		await code(files.run({ exe: "git", argv: ["ls-remote", "ssh://example.invalid/x"], cwd: repo }));

		expect(write).toBe("refused_by_policy");
		expect(existsSync(marker)).toBe(false);
	});

	it("refuses a worktree inside the repository's git directory", async () => {
		const { files, cwd } = await hand();
		const repo = join(cwd, "repo");
		await files.mkdir(repo);
		await files.run({ exe: "git", argv: ["init", "--template="], cwd: repo });

		const refused = await code(
			files.run({
				exe: "git",
				argv: ["worktree", "add", "-b", "h", join(repo, ".git", "hooks"), "HEAD"],
				cwd: repo,
			}),
		);

		expect(refused).toBe("refused_by_policy");
		expect(existsSync(join(repo, ".git", "hooks"))).toBe(false);
	});
});
