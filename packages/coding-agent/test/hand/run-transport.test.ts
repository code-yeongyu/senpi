// senpi#5645 (S40 PR 2, design v3.1 V3/V6): the transport guards the hand adds to the argv its handlers judge. The hooks
// row in run-url-policy.test.ts proves the wrapper's `-c` settings reach a local receive-pack; this file pins which ones.
import { describe, expect, it } from "vitest";
import { transportFor } from "../../src/modes/rpc/hand-run-transport.ts";

const PREFIX = ["-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
const local = [{ kind: "target" as const, value: "file:///m.git" }];
const source = [{ kind: "source" as const, value: "file:///m.git" }];

const receivePack = (argv: readonly string[]) => argv.filter((arg) => arg.startsWith("--receive-pack="));

describe("the transport guards of a run (senpi#5645)", () => {
	it("gives every local push one hardened receive-pack: no hooks, no checked-out update, no fsmonitor, no auto gc", () => {
		const { argv, env } = transportFor([...PREFIX, "push", "--quiet", "file:///m.git", "main:main"], {}, local);
		const [wrapper] = receivePack(argv);
		expect(receivePack(argv)).toHaveLength(1);
		const value = wrapper?.slice("--receive-pack=".length) ?? "";
		expect([value.startsWith("git -c "), value.endsWith(" receive-pack")]).toEqual([true, true]);
		expect(value.slice("git".length, -" receive-pack".length).split(" -c ").filter(Boolean).sort()).toEqual(
			[
				"core.fsmonitor=false",
				"core.hooksPath=/dev/null",
				"gc.auto=0",
				"maintenance.auto=false",
				"receive.autogc=false",
				"receive.denyCurrentBranch=refuse",
			].sort(),
		);
		expect([env.GIT_CONFIG_NOSYSTEM, env.GIT_CONFIG_GLOBAL]).toEqual(["1", "/dev/null"]);
	});

	it("isolates a local ls-remote's config without a receive-pack", () => {
		const { argv, env } = transportFor([...PREFIX, "ls-remote", "file:///m.git", "refs/heads/main"], {}, source);
		expect([receivePack(argv), env.GIT_CONFIG_GLOBAL]).toEqual([[], "/dev/null"]);
	});

	it("forbids local transports on remote runs, after the hand's own protocol setting so they win", () => {
		for (const sub of [
			["ls-remote", "ssh://h/r", "refs/heads/main"],
			["push", "--quiet", "ssh://h/r", "main:main"],
		]) {
			const { argv, env } = transportFor([...PREFIX, ...sub], {}, []);
			const guards = argv.slice(PREFIX.length, PREFIX.length + 6);
			expect([guards, receivePack(argv), env.GIT_CONFIG_GLOBAL]).toEqual([
				["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"],
				[],
				undefined,
			]);
		}
	});

	it("leaves every other subcommand's argv as planned", () => {
		const planned = [...PREFIX, "status", "--porcelain"];
		expect(transportFor(planned, {}, []).argv).toEqual(planned);
	});
});
