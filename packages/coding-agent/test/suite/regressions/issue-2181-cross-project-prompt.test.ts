import { describe, expect, it } from "vitest";
import {
	type CrossProjectChoice,
	chooseCrossProjectAction,
	FORK_PROMPT,
	REBIND_PROMPT,
} from "../../../src/cli/cross-project-session.ts";
import type { RepositoryMatch } from "../../../src/core/repository-identity.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

interface Run {
	readonly action: Awaited<ReturnType<typeof chooseCrossProjectAction>>;
	readonly asked: string[];
	readonly out: string;
	readonly err: string;
}

async function run(match: RepositoryMatch, interactive: boolean, answer = true): Promise<Run> {
	const asked: string[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const choice: CrossProjectChoice = {
		sessionArg: "0197f6e4",
		sessionCwd: "/work/old/repo",
		cwd: "/work/new/repo",
		match,
		interactive,
		confirm: async (message) => {
			asked.push(message);
			return answer;
		},
		out: (line) => out.push(line.replace(ANSI, "")),
		err: (line) => err.push(line.replace(ANSI, "")),
	};
	const action = await chooseCrossProjectAction(choice);
	return { action, asked, out: out.join("\n"), err: err.join("\n") };
}

describe("issue #2181 cross-project --session prompt", () => {
	it("offers to rebind a session of the same repository and shows both paths", async () => {
		const accepted = await run("same", true);

		expect(accepted.action).toBe("rebind");
		expect(accepted.asked).toEqual([REBIND_PROMPT]);
		expect(accepted.out).toContain("Session found in different project: /work/old/repo");
		expect(accepted.out).toContain("This directory is the same git repository: /work/new/repo");
		expect(accepted.out).toContain("--fork '0197f6e4'");
		expect((await run("same", true, false)).action).toBe("abort");
	});

	it("keeps today's fork prompt for a different repository", async () => {
		const result = await run("different", true);

		expect(result.action).toBe("fork");
		expect(result.asked).toEqual([FORK_PROMPT]);
		expect(result.out).not.toContain("--rebind");
		expect((await run("different", true, false)).action).toBe("abort");
	});

	it("points an unrecognised session at --rebind but still asks to fork", async () => {
		const result = await run("unknown", true);

		expect(result.action).toBe("fork");
		expect(result.asked).toEqual([FORK_PROMPT]);
		expect(result.out).toContain("--rebind '0197f6e4'");
	});

	it("never asks without an interactive session and prints the exact commands", async () => {
		const same = await run("same", false);
		const different = await run("different", false);
		const unknown = await run("unknown", false);

		for (const result of [same, different, unknown]) {
			expect(result.action).toBe("fail");
			expect(result.asked).toEqual([]);
			expect(result.err).toContain("Session found in different project: /work/old/repo");
			expect(result.err).toContain("--fork '0197f6e4'");
		}
		expect(same.err).toContain("--rebind '0197f6e4'");
		expect(unknown.err).toContain("--rebind '0197f6e4'");
		expect(different.err).not.toContain("--rebind");
	});
});
