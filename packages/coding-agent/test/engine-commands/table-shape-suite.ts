import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentDirectoryCommand } from "../../src/cli/agent-dir-command.ts";
import { printHelp } from "../../src/cli/args.ts";
import { isAttachToken } from "../../src/cli/attach-args.ts";
import { classifyInvocation } from "../../src/cli/invocation-class.ts";
import { LAUNCH_KEY_FAILED_EXIT_CODE, refuseUnusableLaunchKey } from "../../src/cli/launch-key.ts";
import { dispatchSessionOfPidCommand } from "../../src/cli/session-of-pid-command.ts";
import { DISPLAY_VERSION } from "../../src/config.ts";
import { main } from "../../src/main.ts";
import {
	privateChannelDeclared,
	privateChannelOffered,
	privateFdTableUnreadable,
	privateTablePresent,
} from "../../src/private-fds.ts";
import { EXEMPT, HELP_LATER, REFUSED } from "./invocation-rows.ts";
import { rootFlags } from "./root-options.ts";

/**
 * The shape of the private descriptor table one test file's worker loaded. The module reads the table once, when it
 * loads, so each shape is its own file that sets the table in the environment before anything imports that module.
 */
export type TableShape = "unreadable" | "readable" | "none";

/** The encoded tables, set by each shape file in a hoisted block before its imports run. */
export const SHAPE_TABLES: Readonly<Record<Exclude<TableShape, "none">, string>> = {
	unreadable: '{"presenter":4,',
	// Parses and declares the launch-key channel, taken upstream (null): readable, and no descriptor to adopt or refuse.
	readable: '{"presenter":null,"api-key":null}',
};

class Exited extends Error {
	readonly code: number | string | null | undefined;
	constructor(code: number | string | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

class ReachedActions extends Error {
	constructor() {
		super("main() reached its action branches");
	}
}

type Answer = { readonly exit: number | string | null | undefined; readonly stdout: string; readonly stderr: string };

const LAUNCH_KEY_REFUSAL = "Error: launch_key_unreadable: the private descriptor table could not be read\n";

function firstLine(output: string): string {
	return stripVTControlCharacters(output.split("\n", 1)[0] ?? "");
}

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

/**
 * Runs what the cli-main entry runs for `args`, in process: the classifier's refusal, the two metadata dispatchers, then
 * main(). A test passes `stopAtActions` to observe main()'s action branches through its own seam instead of running them.
 */
async function answerOf(args: readonly string[], stopAtActions: boolean): Promise<Answer> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const collect =
		(sink: string[]) =>
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
			return true;
		};
	vi.spyOn(process.stdout, "write").mockImplementation(collect(stdout) as typeof process.stdout.write);
	// With stdout replaced, main()'s printer writes through console.log directly, so that is collected too.
	vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		stdout.push(`${parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ")}\n`);
	});
	vi.spyOn(process.stderr, "write").mockImplementation(collect(stderr) as typeof process.stderr.write);
	const exit = (code?: number | string | null): never => {
		throw new Exited(code);
	};
	vi.spyOn(process, "exit").mockImplementation(exit);
	const ended = await (async () => {
		if (classifyInvocation(args) === "reads_table") refuseUnusableLaunchKey(undefined, undefined, exit);
		await dispatchAgentDirectoryCommand(args);
		await dispatchSessionOfPidCommand(args);
		await main(
			[...args],
			stopAtActions
				? {
						beforeActions: () => {
							throw new ReachedActions();
						},
					}
				: {},
		);
	})().then(
		() => new Exited(process.exitCode ?? 0),
		(error: unknown) => error,
	);
	vi.restoreAllMocks();
	if (!(ended instanceof Exited)) throw ended;
	return { exit: ended.code, stdout: stdout.join(""), stderr: stderr.join("") };
}

/**
 * Answers help once before any row runs, so no row pays the first help answer's one-time cost: resolving the
 * extensions' help flags and loading the modules that does, a cost no test limit should carry (senpi#7522,
 * senpi#7526). A shape file awaits it at its top level, where collection is not under a test's limit. It asserts
 * its own answer, so a broken help path fails the file at collection instead of hiding behind a warm-up.
 */
export async function warmHelpAnswer(): Promise<void> {
	const savedExitCode = process.exitCode;
	process.exitCode = undefined;
	const answer = await answerOf(["--help"], true);
	process.exitCode = savedExitCode;
	const first = firstLine(answer.stdout);
	if (answer.exit !== 0 || first !== helpScreenFirstLine())
		throw new Error(
			`the warm-up help answer was not the help screen: exit ${String(answer.exit)}, first line ${first}`,
		);
}

/** One shape's suite: the guard that the shape is the one the module captured, then the generated rows. */
export function defineTableShapeSuite(shape: TableShape): void {
	let savedExitCode: typeof process.exitCode;
	beforeEach(() => {
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = savedExitCode;
	});

	describe(`with a private table that is ${shape}`, () => {
		// Every row below is void if this fails: the file would not be testing the shape it names.
		it(`GUARD: the module captured a table that is ${shape}`, () => {
			const captured = {
				present: privateTablePresent(),
				unreadable: privateFdTableUnreadable(),
				declaresKey: privateChannelDeclared("api-key"),
				offersKey: privateChannelOffered("api-key"),
			};
			expect(captured).toEqual(
				shape === "unreadable"
					? { present: true, unreadable: true, declaresKey: false, offersKey: false }
					: shape === "readable"
						? { present: true, unreadable: false, declaresKey: true, offersKey: false }
						: { present: false, unreadable: false, declaresKey: false, offersKey: false },
			);
		});

		it("the generated options are exactly the options the parser matches", () => {
			// parseArgs matches each option by an `arg === "<option>"` branch; --attach alone goes through its unknown-flag
			// table and is recognised by the shared isAttachToken. A new parser option without a table row fails here.
			const parserSource = readFileSync(join(__dirname, "..", "..", "src", "cli", "args.ts"), "utf8");
			const matched = new Set([...parserSource.matchAll(/arg === "(-[^"]+)"/g)].map((match) => match[1]));
			for (const meta of ["--", "--help", "-h", "--version", "-v"]) matched.delete(meta);
			if (isAttachToken("--attach")) matched.add("--attach");
			expect(new Set(rootFlags().map(([name]) => name))).toEqual(matched);
		});

		const options = rootFlags().map((option) => [option.join(" "), option] as const);
		const helpFirstLine = helpScreenFirstLine();
		it("the help reference is the renderer's own non-empty first line", () => {
			expect(helpFirstLine).toMatch(/\S/);
		});

		it.each(options)("help first, then %s: the help screen, before any action branch", async (_option, option) => {
			const answer = await answerOf(["--help", ...option], true);
			expect({
				exit: answer.exit,
				first: firstLine(answer.stdout),
				refused: answer.stderr.includes("launch_key_"),
			}).toEqual({ exit: 0, first: helpFirstLine, refused: false });
		});

		it.each(options)(
			"version first, then %s: the package's version, before any action branch",
			async (_option, option) => {
				const answer = await answerOf(["--version", ...option], true);
				expect({ exit: answer.exit, stdout: answer.stdout.trim(), stderr: answer.stderr }).toEqual({
					exit: 0,
					stdout: DISPLAY_VERSION,
					stderr: "",
				});
			},
		);

		const refusedByClass = [...REFUSED, ...HELP_LATER.filter((args) => classifyInvocation(args) === "reads_table")];
		it.each(refusedByClass.map((args) => [args.join(" "), args] as const))(
			shape === "unreadable"
				? "refuses %s with exit 78 and the fixed line, before any action branch"
				: "never refuses %s for its table",
			async (_args, args) => {
				expect(classifyInvocation(args)).toBe("reads_table");
				if (shape === "unreadable") {
					const answer = await answerOf(args, true);
					expect(answer).toEqual({ exit: LAUNCH_KEY_FAILED_EXIT_CODE, stdout: "", stderr: LAUNCH_KEY_REFUSAL });
					return;
				}
				const exit = vi.fn((code: number): never => {
					throw new Exited(code);
				});
				refuseUnusableLaunchKey(undefined, undefined, exit);
				expect(exit).not.toHaveBeenCalled();
			},
		);

		const exemptByClass = [...EXEMPT, ...HELP_LATER.filter((args) => classifyInvocation(args) === "no_session")];
		it.each(exemptByClass.map((args) => [args.join(" "), args] as const))(
			"answers %s without reading the table",
			async (_args, args) => {
				expect(classifyInvocation(args)).toBe("no_session");
				const answer = await answerOf(args, false);
				expect(answer.exit).not.toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
				expect(`${answer.stdout}${answer.stderr}`).not.toContain("launch_key_");
			},
		);
	});
}
