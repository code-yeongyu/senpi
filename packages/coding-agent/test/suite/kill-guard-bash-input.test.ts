// senpi#5349 / code-yeongyu/oh-my-openagent#12096: bash_input lines are judged as the shell's line editor builds them,
// across calls, reloads and the life of each background session. The tools only record what they were asked to run.
import { describe, expect, it } from "vitest";
import { call, type Outcome, useBashInputHarness } from "./kill-guard-bash-input-harness.ts";

const setup = useBashInputHarness();

describe("kill guard on bash_input line editing", () => {
	it.each([
		["ctrl+a, then type at the start", [{ input: "ill -9 -1\x01k\n", submit: false }]],
		["Home, then type at the start", [{ input: "ill -9 -1\x1b[Hk" }]],
		[
			"ctrl+u, then yank it back with ctrl+y",
			[{ input: "kill -9 -1", submit: false }, { keys: ["ctrl+u"] }, { keys: ["\x19", "enter"] }],
		],
		[
			"a yank on the next line",
			[{ input: "kill -9 -1", submit: false }, { keys: ["ctrl+u", "enter"] }, { keys: ["\x19", "enter"] }],
		],
		["tab completion of a kill-family prefix", [{ input: "kil\t -9 -1\n", submit: false }]],
		["an unknown cursor key between the pieces", [{ input: "ll -9 -1\x1b[1;5Dki" }]],
		["an escape the shell reads shorter than the guard", [{ input: "\x1b[ kill -9 -1\n", submit: false }]],
		["ctrl+v quoting an escape", [{ input: "\x16\x1b[ ; kill -9 -1\n", submit: false }]],
		[
			"ctrl+v, ctrl+u, then kills that overflow the kill ring",
			[{ input: `kill -9 -1 ;\x16\x15${" a\x17".repeat(11)}\n`, submit: false }],
		],
		["an escape left open at Enter", [{ input: "kill -9 -1\x1b[" }]],
		[
			"a backslash continuation across two calls",
			[
				{ input: "kill -9 \\\n", submit: false },
				{ input: "-1\n", submit: false },
			],
		],
		[
			"ctrl+u, ctrl+c, then a yank on the next line",
			[
				{ input: "kill -9 -1", submit: false },
				{ keys: ["ctrl+u"] },
				{ keys: ["ctrl+c"] },
				{ keys: ["\x19", "enter"] },
			],
		],
		[
			"ctrl+u, ctrl+c, then meta-y on the next line",
			[
				{ input: "kill -9 -1", submit: false },
				{ keys: ["ctrl+u"] },
				{ keys: ["ctrl+c"] },
				{ input: "\x1by\n", submit: false },
			],
		],
		[
			"a recalled line killed with ctrl+u, dropped with ctrl+c, then yanked",
			[{ keys: ["up"] }, { keys: ["ctrl+u"] }, { keys: ["ctrl+c"] }, { keys: ["\x19", "enter"] }],
		],
	] as const)("refuses a line built with %s", async (_shape, calls) => {
		const { harness, ran } = await setup();
		const outcomes: Outcome[] = [];
		for (const params of calls) outcomes.push(await call(harness, { bash_id: "b1", ...params }));

		const last = outcomes.at(-1);
		expect(last?.blocked).toBe(true);
		if (last?.blocked) expect(last.text).toContain("[senpi:kill-guard]");
		// Fail closed: an edited line may be refused at an earlier Enter than the one that would run the kill; once a
		// call is refused nothing is written, so every later call that would submit the same line is refused too.
		const firstRefused = outcomes.findIndex((outcome) => outcome.blocked);
		expect(outcomes.slice(firstRefused).every((outcome) => outcome.blocked)).toBe(true);
		expect(ran).toHaveLength(firstRefused);
	});

	it.each([
		["a plain line", [{ input: "ls -la\n", submit: false }]],
		["a plain line with backspaces", [{ input: "echo hi\x7f\x7fhello\n", submit: false }]],
		["an edited line with no kill-family word", [{ input: "ls\x01echo \n", submit: false }]],
		["an edited line without an i or two l", [{ input: "git pull --rebase\x01sudo \n", submit: false }]],
		["an edited line with k and i but no l", [{ input: "echo skip\x01x\n", submit: false }]],
		["tab completion of other words", [{ input: "git ch\t\n", submit: false }]],
		["tab completion after a k word that is no kill prefix", [{ input: "kubectl get po\t\n", submit: false }]],
		["a plain narrow kill", [{ input: "kill 4242\n", submit: false }]],
		[
			"a backslash continuation across two calls",
			[
				{ input: "echo a \\\n", submit: false },
				{ input: "b\n", submit: false },
			],
		],
		[
			"plain lines after ctrl+c dropped a line with the letters of kill",
			[
				{ input: "echo skill", submit: false },
				{ keys: ["ctrl+c"] },
				{ input: "ls\n", submit: false },
				{ input: "pwd\n", submit: false },
			],
		],
		[
			"a plain line after ctrl+c dropped a typed kill",
			[{ input: "kill -9 -1", submit: false }, { keys: ["ctrl+c"] }, { input: "ls\n", submit: false }],
		],
		["a ! inside double quotes before the closing quote", [{ input: 'echo "done!"\n', submit: false }]],
		["a ! followed by a blank", [{ input: "[ ! -f x ] && echo ok\n", submit: false }]],
		["$!", [{ input: "echo $!\n", submit: false }]],
		["a single-quoted !", [{ input: "echo 'a!b'\n", submit: false }]],
		["a negated condition", [{ input: "if ! true; then :; fi\n", submit: false }]],
		["a backslash-escaped !", [{ input: "echo a\\!b\n", submit: false }]],
		["a plain line holding the letters f and c", [{ input: "echo cafe\n", submit: false }]],
	] as const)("lets %s through", async (_shape, calls) => {
		const { harness, ran } = await setup();
		const outcomes: Outcome[] = [];
		for (const params of calls) outcomes.push(await call(harness, { bash_id: "b1", ...params }));

		expect(outcomes).toEqual(calls.map(() => ({ blocked: false })));
		expect(ran).toHaveLength(calls.length);
	});
});

describe("kill guard refuses bash_input lines bash takes from its history", () => {
	const EXPANSION = "history expansion is not judged";
	const RECALL = "history recall is not judged";
	it.each([
		["!!", [{ input: "!!\n", submit: false }], EXPANSION],
		["!!:1*", [{ input: "!!:1*\n", submit: false }], EXPANSION],
		["!-1", [{ input: "!-1\n", submit: false }], EXPANSION],
		["!$", [{ input: "!$\n", submit: false }], EXPANSION],
		["!kill", [{ input: "!kill\n", submit: false }], EXPANSION],
		["echo !:0", [{ input: "echo !:0\n", submit: false }], EXPANSION],
		["^echo ^", [{ input: "^echo ^\n", submit: false }], EXPANSION],
		["fc -s 'echo '=", [{ input: "fc -s 'echo '=\n", submit: false }], EXPANSION],
		["fc", [{ input: "fc\n", submit: false }], EXPANSION],
		["fc after a separator", [{ input: "true; fc -s\n", submit: false }], EXPANSION],
		["a ! typed after a key the guard does not model", [{ input: "echo x\x1b[1;5D!\n", submit: false }], EXPANSION],
		[
			"an unmodelled cursor key that reorders c and f into fc",
			[{ input: "c\x1b[1;5Df\n", submit: false }],
			EXPANSION,
		],
		["Up arrow + Enter", [{ keys: ["up", "enter"] }], RECALL],
		["ctrl+r + Enter", [{ keys: ["\x12", "enter"] }], RECALL],
		[
			"the line ctrl+o (operate-and-get-next) fetched",
			[{ input: "echo hi\x0f", submit: false }, { keys: ["enter"] }],
			RECALL,
		],
	] as const)("refuses %s unjudged", async (_shape, calls, evidence) => {
		const { harness, ran } = await setup();
		const outcomes: Outcome[] = [];
		for (const params of calls) outcomes.push(await call(harness, { bash_id: "b1", ...params }));

		const last = outcomes.at(-1);
		expect(last?.blocked).toBe(true);
		if (last?.blocked) expect(last.text).toContain(`(R5 UNKNOWN): ${evidence}`);
		expect(outcomes.slice(0, -1)).toEqual(calls.slice(0, -1).map(() => ({ blocked: false })));
		expect(ran).toHaveLength(calls.length - 1);
	});
});

describe("kill guard keeps typed text for the life of each background session", () => {
	it("judges text typed before a session reload at the Enter after it", async () => {
		const { harness } = await setup();

		expect(await call(harness, { bash_id: "b1", input: "kill -9 ", submit: false })).toEqual({ blocked: false });
		await harness.session.reload();
		const enter = await call(harness, { bash_id: "b1", input: "-1" });

		expect(enter.blocked).toBe(true);
	});

	it("drops typed text only when its background session ends", async () => {
		const { harness, running } = await setup();
		running(["b1", "b2"]);
		await call(harness, { bash_id: "b1", input: "kill -9 ", submit: false });
		await call(harness, { bash_id: "b2", input: "kill -9 ", submit: false });

		running(["b2"]);

		expect(await call(harness, { bash_id: "b1", input: "-1" })).toEqual({ blocked: false });
		expect((await call(harness, { bash_id: "b2", input: "-1" })).blocked).toBe(true);
	});
});
