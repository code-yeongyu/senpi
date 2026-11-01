// senpi#5349 / code-yeongyu/oh-my-openagent#12096: the kill guard's judge, decided on synthetic process tables so every
// rule is deterministic on every OS. Nothing here sends a signal or reads the real process table.
import { describe, expect, it } from "vitest";
import { judgeCommand, judgePattern, KILL_GUARD_TAG } from "../../src/core/kill-guard/index.ts";
import { AGENT, TABLE, fixture, rule } from "./judge-fixtures.ts";

describe("R1 BROAD_PATTERN: our own ERE reader, independent of the host engine", () => {
	it.each([
		// The reporter's exact pattern: `||` is an empty alternative, so glibc matched every command line.
		['paid" 2>/dev/null || echo 1', "substring"],
		["foo|", "substring"],
		["|bar", "substring"],
		["a||b", "substring"],
		["(|x)", "substring"],
		["(x|)", "substring"],
		["()", "substring"],
		["", "substring"],
		[".*", "substring"],
		["^", "substring"],
		["^$", "substring"],
		["x*", "substring"],
		["(ab)?", "substring"],
		["[a-z]*", "substring"],
		["[a-z]", "substring"],
		["[^x][^y]", "substring"],
		[".+.", "substring"],
		["\\w\\s", "substring"],
		["a.*", "substring"],
		["a.", "substring"],
		["^a.*", "substring"],
		["vite|a", "substring"],
		["R", "substring"],
		["^x$", "substring"],
		["(unbalanced", "substring"],
		["[unbalanced", "substring"],
		["a{2", "substring"],
		["ab{3,1}", "substring"],
		[".*", "exact"],
		["", "exact"],
	] as const)("refuses %j (%s)", (pattern, mode) => {
		expect(judgePattern(pattern, mode).broad).toBe(true);
	});

	it.each([
		["vite --port 5173", "substring"],
		["^node .*/server.js$", "substring"],
		["ab", "substring"],
		["vite|ab", "substring"],
		["my-worker-[0-9]+", "substring"],
		["omo-worker-[0-9]+", "substring"],
		["\\bvite\\b", "substring"],
		["a{2}", "substring"],
		["R", "exact"],
		["X", "exact"],
		["redis-server", "exact"],
		["g++", "exact"],
	] as const)("allows %j (%s)", (pattern, mode) => {
		expect(judgePattern(pattern, mode).broad).toBe(false);
	});
});

describe("pkill / killall / kill command lines", () => {
	it("refuses the reporter's command before anything is resolved (C18)", () => {
		const { context, selections } = fixture();
		const verdict = judgeCommand(`pkill -f 'paid" 2>/dev/null || echo 1' ; true`, context);
		expect(rule(verdict)).toBe("R1");
		expect(selections).toEqual([]);
		if (verdict.action !== "refuse") throw new Error("expected a refusal");
		expect(verdict.message.startsWith(`${KILL_GUARD_TAG} `)).toBe(true);
		expect(verdict.message).not.toContain("\n");
		expect(verdict.message).toContain("terminal.killGuard");
	});

	it("names the -x rewrite for a one-letter substring pattern (C8s)", () => {
		const verdict = judgeCommand("pkill R", fixture().context);
		expect(rule(verdict)).toBe("R1");
		if (verdict.action === "refuse") expect(verdict.message).toContain("pkill -x R");
	});

	it.each([
		["pkill -f 'a.*'"],
		["pkill -f 'a.'"],
		["pkill -f '^a.*'"],
		["pkill -f 'vite|a'"],
		["pkill -x '.*'"],
		['pkill -f ""'],
		["pkill -9 -f '.*'"],
		["pkill --signal KILL -f '|x'"],
		["sudo pkill -f '.*'"],
		["timeout 5 pkill -f 'x*'"],
		["bash -c \"pkill -f '.*'\""],
		["pgrep -f 'a||b' | xargs kill"],
	])("refuses %s with R1 (A2)", (command) => {
		expect(rule(judgeCommand(command, fixture().context))).toBe("R1");
	});

	it.each([
		["pkill -f 'vite --port 5173'"],
		["pkill -f '^node .*/server.js$'"],
		["pkill -f ab"],
		["pkill -f 'vite|ab'"],
		["pkill -x R"],
		["pkill -x X"],
		["pkill -x redis-server"],
		["pkill -P 4242"],
		["pkill -0 -f vite"],
	])("allows %s when it selects no protected process (C7, C8, C8x, C9)", (command) => {
		expect(judgeCommand(command, fixture({ select: () => [600] }).context)).toEqual({ action: "allow" });
	});

	it("drops pkill-only options from the dry run instead of calling them unknown (A3)", () => {
		const { context, selections } = fixture({ select: () => [600] });
		expect(judgeCommand("pkill -e -f 'vite --port 5173'", context)).toEqual({ action: "allow" });
		expect(judgeCommand("pkill --queue 5 -f 'vite --port 5173'", context)).toEqual({ action: "allow" });
		expect(selections).toEqual([
			["-f", "vite --port 5173"],
			["-f", "vite --port 5173"],
		]);
	});

	it("drops BSD -I from the dry run and forwards the rest (A3)", () => {
		const { context, selections } = fixture({ platform: "darwin", select: () => [600] });
		expect(judgeCommand("pkill -I -f 'vite --port 5173'", context)).toEqual({ action: "allow" });
		expect(selections).toEqual([["-a", "-f", "vite --port 5173"]]);
	});

	it("refuses an option outside the table as UNKNOWN", () => {
		expect(rule(judgeCommand("pkill --frobnicate -f vite", fixture().context))).toBe("R5");
		expect(rule(judgeCommand("pkill -M core -f vite", fixture({ platform: "darwin" }).context))).toBe("R5");
	});

	it.each([
		["pkill -u 501", [1, 200, 300, 400, AGENT, 600]],
		["pkill -x bun", [AGENT]],
		["pkill -f senpi", [AGENT]],
		["pkill -v -f foo", TABLE.map((entry) => entry.pid)],
		["pkill -P 400", [AGENT]],
	] as const)("refuses %s that selects a protected process (C17, C21, C26, C9)", (command, selected) => {
		const verdict = judgeCommand(command, fixture({ select: () => selected }).context);
		expect(rule(verdict)).toBe("R2");
		if (verdict.action === "refuse") expect(verdict.message).toContain(`${AGENT} bun`);
	});

	it("names the user service manager as protected on Linux", () => {
		const verdict = judgeCommand("pkill -x systemd", fixture({ select: () => [200] }).context);
		expect(rule(verdict)).toBe("R2");
	});

	it("maps BSD's default ancestor exclusion to the caller: the shell's ancestors are never selected (darwin)", () => {
		expect(
			judgeCommand("pkill -f senpi", fixture({ platform: "darwin", select: () => [AGENT, 400] }).context),
		).toEqual({ action: "allow" });
		expect(
			rule(judgeCommand("pkill -a -f senpi", fixture({ platform: "darwin", select: () => [AGENT] }).context)),
		).toBe("R2");
	});

	it("resolves -g 0 against the caller: a fresh shell's own group holds no protected process", () => {
		const fresh = fixture({ select: () => [AGENT] });
		expect(judgeCommand("pkill -g 0 sleep", fresh.context)).toEqual({ action: "allow" });
		expect(fresh.selections).toEqual([]);
		const inThread = fixture({ vantage: { kind: "agent" }, shell: "bun", select: () => [AGENT] });
		expect(rule(judgeCommand("pkill -g 0 sleep", inThread.context))).toBe("R2");
		expect(inThread.selections).toEqual([["-g", String(AGENT), "sleep"]]);
	});

	it("refuses killall -u and no-name killall/pkill (C17, R3)", () => {
		expect(rule(judgeCommand("killall -u 501", fixture({ select: () => [AGENT] }).context))).toBe("R2");
		expect(rule(judgeCommand("killall", fixture().context))).toBe("R3");
		expect(rule(judgeCommand("pkill", fixture().context))).toBe("R3");
	});

	it.each([
		["killall Finder", "darwin"],
		["killall -q myapp", "linux"],
		["killall R", "linux"],
		["killall -9 redis-server", "linux"],
	] as const)("allows %s on %s (C8, C8x)", (command, platform) => {
		expect(judgeCommand(command, fixture({ platform, select: () => [700] }).context)).toEqual({ action: "allow" });
	});

	it("matches a killall name literally in its dry run", () => {
		const { context, selections } = fixture({ select: () => [] });
		expect(judgeCommand("killall g++", context)).toEqual({ action: "allow" });
		expect(selections).toEqual([["-x", "g\\+\\+"]]);
	});

	it("judges BSD killall -m as a pattern and its matches as targets (C27)", () => {
		expect(rule(judgeCommand("killall -m '.*'", fixture({ platform: "darwin" }).context))).toBe("R1");
		expect(judgeCommand("killall -m 'ba.*'", fixture({ platform: "darwin", select: () => [700] }).context)).toEqual({
			action: "allow",
		});
		expect(
			rule(judgeCommand("killall -m 'ba.*'", fixture({ platform: "darwin", select: () => [400] }).context)),
		).toBe("R2");
		expect(judgeCommand("killall -s Finder", fixture({ platform: "darwin", select: () => [AGENT] }).context)).toEqual(
			{
				action: "allow",
			},
		);
	});

	it("judges psmisc killall -g as a group form (C28)", () => {
		expect(rule(judgeCommand("killall -g zsh", fixture({ select: () => [400] }).context))).toBe("R4");
		expect(judgeCommand("killall -g worker", fixture({ select: () => [4000] }).context)).toEqual({ action: "allow" });
	});

	it("judges every BSD pattern and the union of their matches (C29)", () => {
		expect(rule(judgeCommand("pkill foo b", fixture({ platform: "darwin" }).context))).toBe("R1");
		expect(judgeCommand("pkill foo bar", fixture({ platform: "darwin", select: () => [600] }).context)).toEqual({
			action: "allow",
		});
	});

	it("refuses killall with age filters it cannot resolve", () => {
		expect(rule(judgeCommand("killall -o 5m node", fixture().context))).toBe("R5");
	});

	it("fails closed when the dry run fails or the table cannot be read (R5, C25)", () => {
		expect(rule(judgeCommand("pkill -f vite", fixture({ select: () => "fail" }).context))).toBe("R5");
		const blind = fixture({ table: "unreadable" });
		expect(rule(judgeCommand("pkill -f vite", blind.context))).toBe("R5");
		expect(rule(judgeCommand("kill -- -4000", blind.context))).toBe("R5");
		expect(judgeCommand("kill 12345", blind.context)).toEqual({ action: "allow" });
		expect(rule(judgeCommand("kill 400", blind.context))).toBe("R2");
		expect(rule(judgeCommand("kill 1", blind.context))).toBe("R2");
	});
});
