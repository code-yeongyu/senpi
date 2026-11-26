import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, printHelp } from "../../src/cli/args.ts";
import { classifyInvocation, INVOCATION_CLASSES } from "../../src/cli/invocation-class.ts";
import { LAUNCH_KEY_FAILED_EXIT_CODE } from "../../src/cli/launch-key.ts";
import { ENGINE_COMMANDS } from "../../src/engine/metadata.ts";
import { CLI, CLI_MAIN, type RealEngineRun, realEngine, runsStillAlive } from "./real-engine.ts";

const EXEMPT: ReadonlyArray<readonly string[]> = [
	["--version"],
	["--help"],
	["-h"],
	["-v"],
	["--list-tips"],
	["config", "agent-dir", "--json"],
	["session-of-pid", "--json"],
	["host", "status", "--json"],
	["host", "stop", "--json"],
	["list"],
	["install", "--help"],
	["config", "--help"],
	["schedule", "list", "--json"],
];
const REFUSED: ReadonlyArray<readonly string[]> = [
	["--print-prompt-sizes"],
	["--print", "hello"],
	["hello"],
	["host", "ensure", "--json"],
	["host", "handoff", "--json"],
	["--internal-rpc-host-supervisor"],
	["-p", "--help"],
	["--print", "--version"],
	["--print-prompt-sizes", "-h"],
	["host", "ensure", "--help"],
	["--print", "--", "--help"],
	["--print", "--", "--version"],
	["-p", "--system-prompt", "--list-tips", "hello"],
	["-p", "--model", "--list-tips", "hello"],
	["--system-prompt", "--list-tips", "hello"],
	["--internal-rpc-host-supervisor", "x", "--list-tips"],
	["--list-tips", "--attach", "unix:///tmp/x.sock", "--session", "s-1"],
	["--list-tips", "--attach=unix:///tmp/x.sock", "--session", "s-1"],
	["--system-prompt", "--version", "hello"],
	["auth", "check", "--help"],
	["models", "discover", "--help"],
	["schedule", "run", "--help"],
];
const UNREADABLE: ReadonlyArray<readonly [string, string]> = [
	["not json", "garbage"],
	["cut short", '{"presenter":4,'],
	["over the read limit", `{"pad":"${"x".repeat(4200)}","api-key":5}`],
];
const ENTRIES = [
	["cli.ts", CLI],
	["cli-main", CLI_MAIN],
] as const;

describe("the invocation classifier (security design B10, F3 ruling)", () => {
	const unclassified = (table: Readonly<Record<string, unknown>>): string[] =>
		ENGINE_COMMANDS.map((command) => command.call).filter((call) => table[call] === undefined);

	it("classifies every command form of the engine's command table", () => {
		expect(unclassified(INVOCATION_CLASSES)).toEqual([]);
	});

	it("names the command a table without its row is missing (control)", () => {
		const { "host.gc": _removed, ...short } = INVOCATION_CLASSES;
		expect(unclassified(short)).toEqual(["host.gc"]);
	});

	it("gives every row a reason", () => {
		expect(Object.entries(INVOCATION_CLASSES).filter(([, row]) => row.reason.trim() === "")).toEqual([]);
	});

	it("exempts exactly the entries that start no session", () => {
		const exempt = Object.entries(INVOCATION_CLASSES)
			.filter(([, row]) => row.kind === "no_session")
			.map(([call]) => call)
			.sort();
		expect(exempt).toEqual([
			"config.agentDir",
			"config.resources",
			"config.setResource",
			"host.status",
			"host.stop",
			"packages.install",
			"packages.list",
			"packages.remove",
			"packages.update",
			"schedule.cancel",
			"schedule.list",
			"sessionOfPid",
			"tips",
		]);
	});

	it.each([
		[["install", "--help"]],
		[["config", "--help"]],
		[["schedule", "list", "--help"]],
		[["update"]],
		[["session-of-pid", "1"]],
	])("lets a later help flag follow an exempt command's class: %j", (args) =>
		expect(classifyInvocation(args)).toBe("no_session"),
	);

	const valueOptions = [
		...new Set(
			ENGINE_COMMANDS.filter((command) => command.argv.length === 0)
				.flatMap((command) => command.flags)
				.filter((flag) => flag.takesValue)
				.flatMap((flag) => flag.names),
		),
	];
	it.each(
		valueOptions.flatMap((option) =>
			["--list-tips", "--help", "--version", "-h", "-v"].map((exempt) => [exempt, option] as const),
		),
	)("refuses %s as the value of %s: a token the parser may consume as a value never exempts", (exempt, option) => {
		expect(classifyInvocation(["-p", option, exempt, "hello"])).toBe("reads_table");
		expect(classifyInvocation([option, exempt, "hello"])).toBe("reads_table");
	});

	it("still exempts --list-tips as the first argument", () => {
		expect(classifyInvocation(["--list-tips", "--offline"])).toBe("no_session");
	});

	it.each(EXEMPT)("exempts %s", (...args) => expect(classifyInvocation(args)).toBe("no_session"));
	it.each(REFUSED)("refuses %s", (...args) => expect(classifyInvocation(args)).toBe("reads_table"));

	it.each([
		[["--print", "--", "-h"]],
		[["--print", "--", "--version"]],
		[["--model", "m", "-h"]],
		[["-p", "--help"]],
		[["auth", "check", "--help"]],
		[["models", "discover", "--help"]],
		[["--", "--help"]],
		[["--", "--version"]],
		[["update", "--models"]],
		[["--", "host", "status"]],
		[["--internal-rpc-host-supervisor", "--help-me"]],
		[["unknown-command"]],
	])("refuses %j: help and version count only first, nothing counts after --, the unknown refuses", (args) => {
		expect(classifyInvocation(args)).toBe("reads_table");
	});
});

describe("the real parser agrees with every root exemption, in the safe direction", () => {
	const firstTokens = {
		"--help": "help",
		"-h": "help",
		"--version": "version",
		"-v": "version",
		"--list-tips": "listTips",
	} as const;
	const tails: ReadonlyArray<readonly string[]> = [[], ["--offline"], ["-p", "hello"], ["--mode", "rpc"], ["--", "x"]];

	it.each(Object.entries(firstTokens).flatMap(([token, field]) => tails.map((tail) => [token, tail, field] as const)))(
		"exempts %s %j only where the parser reads it as %s",
		(token, tail, field) => {
			const args = [token, ...tail];
			if (classifyInvocation(args) === "no_session") expect(parseArgs([...args])[field]).toBe(true);
			if (tail.length === 0) expect(classifyInvocation(args)).toBe("no_session");
		},
	);

	it.each([
		[["--list-tips", "--mode", "rpc"]],
		[["--list-tips", "-p", "hello"]],
		[["--list-tips", "--print", "hello"]],
	])("refuses %j: a first-token exemption that also names a session start ties, and a tie never exempts", (args) =>
		expect(classifyInvocation(args)).toBe("reads_table"),
	);

	it("reads nothing after -- as an option: what follows is a message", () => {
		expect(classifyInvocation(["--list-tips", "--", "--mode", "rpc"])).toBe("no_session");
		expect(classifyInvocation(["host", "status", "--", "--mode", "rpc"])).toBe("no_session");
	});

	it.each(
		valueOptionsOfRootForms().flatMap((option) =>
			Object.keys(firstTokens).map((exempt) => [exempt, option] as const),
		),
	)("never exempts %s where %s may consume it as a value", (exempt, option) => {
		expect(classifyInvocation(["-p", option, exempt, "hello"])).toBe("reads_table");
	});
});

function firstLine(output: string): string {
	return stripVTControlCharacters(output.split("\n", 1)[0] ?? "");
}

/** The help screen's first line as printHelp renders it, read in process (it does not depend on extension flags). */
function helpScreenFirstLine(): string {
	const lines: string[] = [];
	const log = console.log;
	console.log = (...parts: unknown[]) => {
		lines.push(parts.map(String).join(" "));
	};
	try {
		printHelp([]);
	} finally {
		console.log = log;
	}
	return firstLine(lines.join("\n"));
}
const HELP_SCREEN_FIRST_LINE = helpScreenFirstLine();

/** Every option of the engine's root command forms, with a value operand where it takes one. */

function valueOptionsOfRootForms(): string[] {
	return [
		...new Set(
			ENGINE_COMMANDS.filter((command) => command.argv.length === 0)
				.flatMap((command) => command.flags)
				.filter((flag) => flag.takesValue)
				.flatMap((flag) => flag.names),
		),
	];
}

describe("every spelling the parser accepts classes the same (review 6070067184)", () => {
	/** Each option that turns an invocation into a start, and how the parser's own result shows it started. */
	const STARTS: ReadonlyArray<readonly [string, readonly string[], (args: ReturnType<typeof parseArgs>) => boolean]> =
		[
			["print", ["--print", "-p"], (args) => args.print === true],
			["rpc", ["--mode"], (args) => args.mode === "rpc"],
			["hand", ["--hand"], (args) => args.hand === true],
			["headless", ["--headless"], (args) => args.headless === true],
			["attach", ["--attach"], (args) => args.attach !== undefined],
		];
	const value = { print: [], rpc: ["rpc"], hand: [], headless: [], attach: ["unix:///tmp/x.sock"] } as const;
	const spellings = STARTS.flatMap(([name, flags, started]) =>
		flags.flatMap((flag) => {
			const operand: readonly string[] = value[name as keyof typeof value];
			const joined = flag.startsWith("--") && operand.length > 0 ? [[`${flag}=${operand[0]}`]] : [];
			return [[flag, ...operand], ...joined].map((spelled) => [name, spelled, started] as const);
		}),
	);

	it.each(spellings.map(([name, spelled, started]) => [spelled.join(" "), name, spelled, started] as const))(
		"--list-tips %s refuses exactly when the parser reads a %s start",
		(_spelled, _name, spelled, started) => {
			const args = ["--list-tips", ...spelled, "--session", "s-1"];
			const parsed = parseArgs([...args]);
			expect(classifyInvocation(args)).toBe(started(parsed) ? "reads_table" : "no_session");
		},
	);
});

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-invocation-class-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// The options whose help-first invocation took an action branch before the first-token answer (measured red against
// aa140b8cd9). Every root option is covered in process (help-first-in-process.test.ts); these stay at the real entry,
// with the plain --help that proves the binary reaches main()'s answer.
const HELP_FIRST_REDS: ReadonlyArray<readonly string[]> = [
	["--help"],
	["--help", "--hand"],
	["--help", "--headless"],
	["--help", "--export", "x"],
	["-h", "--export", "x"],
	["--help", "--mcp-presenter-fd", "x"],
	["--help", "--mode", "x"],
	["--help", "--session-runtime", "x"],
	["--help", "--spawned-by", "x"],
	["--help", "--thinking", "x"],
	["--help", "--tool-runtime", "x"],
	["--help", "--tui-mode", "x"],
];

afterAll(() => expect(runsStillAlive()).toEqual([]));

describe.each(ENTRIES)("the real %s entry", (_name, entry) => {
	const BROKEN = '{"presenter":4,';
	const run = (args: readonly string[], table: string | undefined) => realEngine(args, { root, table, entry });
	// A comparison of a broken-table run with a bare run is two tests of one process each: the bare answer is recorded
	// first and the broken run is compared with it, so no test depends on two processes fitting its timeout together.
	// Each test has its own root, so the root a run printed is replaced before the two answers are compared.
	const rootless = (answer: RealEngineRun): RealEngineRun => ({
		code: answer.code,
		output: answer.output.replaceAll(root, "<root>"),
	});
	const bareAnswers = new Map<string, RealEngineRun>();
	const bareKey = (args: readonly string[]) => args.join("\0");
	const recordBare = async (args: readonly string[]) => {
		bareAnswers.set(bareKey(args), rootless(await run(args, undefined)));
	};
	const bareAnswer = (args: readonly string[]) => {
		const answer = bareAnswers.get(bareKey(args));
		if (answer === undefined) throw new Error(`no bare answer recorded for ${args.join(" ")}`);
		return answer;
	};
	const exemptClassRows = EXEMPT.flatMap((args) => [
		args,
		[...args, "--attach", "unix:///tmp/e1as-none.sock", "--session", "s-1"],
	]).filter((args) => classifyInvocation(args) === "no_session");

	it.each(exemptClassRows.map((args) => [args.join(" "), args] as const))(
		"the bare answer of %s (the reference for its class row)",
		async (_args, args) => recordBare(args),
	);

	it.each(
		EXEMPT.flatMap((args) => [args, [...args, "--attach", "unix:///tmp/e1as-none.sock", "--session", "s-1"]]).map(
			(args) => [args.join(" "), args] as const,
		),
	)("the class of %s is the branch main() takes (review 6069794971)", async (_args, args) => {
		const broken = await run(args, BROKEN);
		if (classifyInvocation(args) === "reads_table") {
			expect(broken.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
			return;
		}
		expect(rootless(broken)).toEqual(bareAnswer(args));
	});

	// Review 6070848877 (F1b): help first must still be help at the real entry, or the classifier must refuse it.
	it.each(HELP_FIRST_REDS.map((args) => [args.join(" "), args] as const))(
		"help first, then %s: the answer is help, or the classifier refuses",
		async (_args, args) => {
			if (entry !== CLI_MAIN) return;
			const broken = await run(args, BROKEN);
			if (classifyInvocation(args) === "reads_table") {
				expect(broken.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
				return;
			}
			// Comparing with a run without a table cannot see a branch that fails the same way either way (an export of a
			// missing session): an exempt help-first invocation must answer with the help screen itself.
			expect({ code: broken.code, first: firstLine(broken.output) }).toEqual({
				code: 0,
				first: HELP_SCREEN_FIRST_LINE,
			});
		},
	);

	// Help in a LATER position keeps the owner's rule: the command decides, so a start refuses on a broken table.
	const HELP_LATER: ReadonlyArray<readonly string[]> = [
		["--hand", "--help"],
		["--headless", "--help"],
		["--export", "x", "--help"],
		["-p", "x", "--help"],
		["--mode", "rpc", "--help"],
	];
	it.each(
		HELP_LATER.filter((args) => classifyInvocation(args) === "no_session").map(
			(args) => [args.join(" "), args] as const,
		),
	)("the bare answer of %s (the reference for its help-later row)", async (_args, args) => {
		if (entry !== CLI_MAIN) return;
		await recordBare(args);
	});
	it.each(HELP_LATER.map((args) => [args.join(" "), args] as const))(
		"help later, %s: the command's class decides",
		async (_args, args) => {
			if (entry !== CLI_MAIN) return;
			const broken = await run(args, BROKEN);
			if (classifyInvocation(args) === "reads_table") {
				expect(broken.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
				return;
			}
			expect(rootless(broken)).toEqual(bareAnswer(args));
		},
	);

	it.each(
		REFUSED.flatMap((args) => UNREADABLE.map(([shape, table]) => [args.join(" "), shape, args, table] as const)),
	)("refuses %s on a table %s with exit 78", async (_args, _shape, args, table) => {
		const refused = await run(args, table);
		expect(refused.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
		expect(refused.output).toContain("launch_key_unreadable: the private descriptor table could not be read");
		expect(refused.output).not.toContain("presenter");
	});

	it.each(EXEMPT.map((args) => [args.join(" "), args] as const))(
		"answers %s byte-identically with and without an unreadable table",
		async (_args, args) => {
			const broken = await run(args, BROKEN);
			expect(rootless(broken)).toEqual(bareAnswer(args));
			expect(broken.output).not.toContain("launch_key_");
		},
	);
});
