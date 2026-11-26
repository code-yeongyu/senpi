import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, printHelp } from "../../src/cli/args.ts";
import { classifyInvocation, INVOCATION_CLASSES } from "../../src/cli/invocation-class.ts";
import { LAUNCH_KEY_FAILED_EXIT_CODE } from "../../src/cli/launch-key.ts";
import { DISPLAY_VERSION } from "../../src/config.ts";
import { ENGINE_COMMANDS } from "../../src/engine/metadata.ts";
import { EXEMPT, REFUSED, UNREADABLE } from "./invocation-rows.ts";
import { CLI, CLI_MAIN, realEngine, runsStillAlive } from "./real-engine.ts";

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

// The real entries start a process only where a process is what is tested (security owner's ruling on #7463): the plain
// --help, the options whose help-first invocation took an action branch before the fix (measured red against
// aa140b8cd9), and one row per entry file per answer class. Every other invocation is covered in process, once per
// table shape, by the table-shape-*.test.ts files.
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
const BROKEN = '{"presenter":4,';

afterAll(() => expect(runsStillAlive()).toEqual([]));

describe("the real cli-main entry, help first on an unreadable table (review 6070848877, F1b)", () => {
	it.each(HELP_FIRST_REDS.map((args) => [args.join(" "), args] as const))(
		"%s: the help screen",
		async (_args, args) => {
			const run = await realEngine(args, { root, table: BROKEN, entry: CLI_MAIN });
			expect({ code: run.code, first: firstLine(run.output) }).toEqual({ code: 0, first: HELP_SCREEN_FIRST_LINE });
		},
	);
});

describe.each(ENTRIES)("the real %s entry, one row per answer class on an unreadable table", (_name, entry) => {
	it("help: the help screen", async () => {
		const run = await realEngine(["--help"], { root, table: BROKEN, entry });
		expect({ code: run.code, first: firstLine(run.output) }).toEqual({ code: 0, first: HELP_SCREEN_FIRST_LINE });
	});

	it("version: the version line", async () => {
		const run = await realEngine(["--version"], { root, table: BROKEN, entry });
		expect({ code: run.code, output: run.output.trim() }).toEqual({ code: 0, output: DISPLAY_VERSION });
	});

	it.each(UNREADABLE)(
		"refusal on a table %s: exit 78 and the fixed line, quoting nothing of the table",
		async (_shape, table) => {
			const run = await realEngine(["--print", "hello"], { root, table, entry });
			expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
			expect(run.output).toContain("launch_key_unreadable: the private descriptor table could not be read");
			expect(run.output).not.toContain("presenter");
		},
	);
});
