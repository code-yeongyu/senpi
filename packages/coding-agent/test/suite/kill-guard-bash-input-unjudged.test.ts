// senpi#5349 / code-yeongyu/oh-my-openagent#12096, review round 5: a bash_input line bash could run as something the
// guard did not see (a key it cannot follow, shell reconfiguration, a command word it cannot read) is refused unjudged.
import { describe, expect, it } from "vitest";
import { call, type Outcome, useBashInputHarness } from "./kill-guard-bash-input-harness.ts";

const setup = useBashInputHarness();

const UNMODELLED_KEY = "the line was edited with a key the guard cannot follow";
const RECONFIGURE = "changing the shell's key bindings, history or aliases through bash_input is not judged";
const DYNAMIC = "a bash_input command word built by an expansion or ANSI-C quoting is not judged";
const UNPARSED = "a bash_input line the guard cannot parse is not judged";
const EXPANSION = "history expansion is not judged";

async function send(input: string): Promise<{ outcome: Outcome; ran: readonly string[] }> {
	const { harness, ran } = await setup();
	return { outcome: await call(harness, { bash_id: "b1", input, submit: false }), ran };
}

describe("kill guard refuses bash_input lines it cannot know bash runs as typed", () => {
	it.each([
		["vi-mode recall (ESC k)", "\x1bk\n", UNMODELLED_KEY],
		["an unknown CSI key", "\x1b[25~\n", UNMODELLED_KEY],
		["meta-b, a meta key the guard does not model", "echo hi\x1bb\n", UNMODELLED_KEY],
		["a key rebound with bind", `bind '"\\C-x": previous-history'\n`, RECONFIGURE],
		["vi mode", "set -o vi\n", RECONFIGURE],
		["new history characters", "histchars=@\n", RECONFIGURE],
		["a hist* shell option", "shopt -s histverify\n", RECONFIGURE],
		["a line stored into history", "history -s 'kill -9 -1'\n", RECONFIGURE],
		["an alias definition", "alias k=kill\n", RECONFIGURE],
		["fc named with ANSI-C quoting", "$'fc' -s\n", DYNAMIC],
		["a command word from an expansion", '"$cmd" -s\n', DYNAMIC],
		["fc named with double quotes", '"fc" -s\n', EXPANSION],
		["an unparsable line naming kill", "case x in y) kill 1;; esac\n", UNPARSED],
	] as const)("refuses %s", async (_shape, input, evidence) => {
		const { outcome, ran } = await send(input);

		expect(outcome.blocked).toBe(true);
		if (outcome.blocked) expect(outcome.text).toContain(`(R5 UNKNOWN): ${evidence}`);
		expect(ran).toEqual([]);
	});

	it.each([
		["a plain line", "ls -la\n"],
		["tab completion of other words", "git ch\t\n"],
		["a plain line holding f and c", "echo cafe\n"],
		["a history listing", "history\n"],
		["an alias listing", "alias\n"],
		["a set -o listing", "set -o\n"],
		["the word histchars as an argument", "echo histchars\n"],
		["ctrl+a then sudo, modelled keys without the letters of kill", "ls\x01sudo \n"],
		["meta-y, a modelled yank", "echo x\x1by\n"],
		["an unparsable line naming none of those commands", "case x in y) echo hi;; esac\n"],
	] as const)("lets %s through", async (_shape, input) => {
		const { outcome, ran } = await send(input);

		expect(outcome).toEqual({ blocked: false });
		expect(ran).toHaveLength(1);
	});
});
