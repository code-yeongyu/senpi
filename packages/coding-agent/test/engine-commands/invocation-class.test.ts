import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyInvocation, INVOCATION_CLASSES } from "../../src/cli/invocation-class.ts";
import { LAUNCH_KEY_FAILED_EXIT_CODE } from "../../src/cli/launch-key.ts";
import { ENGINE_COMMANDS } from "../../src/engine/metadata.ts";
import { CLI, CLI_MAIN, realEngine } from "./real-engine.ts";

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

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-invocation-class-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(ENTRIES)("the real %s entry", (_name, entry) => {
	it.each(
		REFUSED.flatMap((args) => UNREADABLE.map(([shape, table]) => [args.join(" "), shape, args, table] as const)),
	)("refuses %s on a table %s with exit 78", async (_args, _shape, args, table) => {
		const run = await realEngine(args, { root, table, entry });
		expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
		expect(run.output).toContain("launch_key_unreadable: the private descriptor table could not be read");
		expect(run.output).not.toContain("presenter");
	});

	it.each(EXEMPT.map((args) => [args.join(" "), args] as const))(
		"answers %s byte-identically with and without an unreadable table",
		async (_args, args) => {
			const bare = await realEngine(args, { root, table: undefined, entry });
			const broken = await realEngine(args, { root, table: '{"presenter":4,', entry });
			expect(broken).toEqual(bare);
			expect(broken.output).not.toContain("launch_key_");
		},
	);
});
