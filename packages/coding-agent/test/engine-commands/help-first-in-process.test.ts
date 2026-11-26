import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAttachToken } from "../../src/cli/attach-args.ts";
import { classifyInvocation } from "../../src/cli/invocation-class.ts";
import { main } from "../../src/main.ts";
import { rootFlags } from "./root-options.ts";

// Help or version as the first token is answered by main() itself, before any action branch, for every root option
// after it (review 6070848877, F1b). main() is the function the binary calls (cli-main.ts awaits it with the process
// arguments); here it runs in process with a broken private table, so every row costs one in-process help render and
// no new process. The action branches are observed through main()'s own `beforeActions` seam, never a module mock.

const BROKEN_TABLE = '{"presenter":4,';

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

type Answer = {
	readonly exit: number | string | null | undefined;
	readonly firstLine: string;
	readonly output: string;
};

let savedTable: string | undefined;
let savedExitCode: typeof process.exitCode;
beforeEach(() => {
	savedTable = process.env.SENPI_PRIVATE_FDS;
	savedExitCode = process.exitCode;
	process.env.SENPI_PRIVATE_FDS = BROKEN_TABLE;
});
afterEach(() => {
	vi.restoreAllMocks();
	if (savedTable === undefined) delete process.env.SENPI_PRIVATE_FDS;
	else process.env.SENPI_PRIVATE_FDS = savedTable;
	process.exitCode = savedExitCode;
});

async function answerOf(args: readonly string[]): Promise<Answer> {
	const chunks: string[] = [];
	// Collects what main() writes and completes each write at once, as a writable stream does: main() waits for its
	// output's write callback before it exits.
	vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
		return true;
	}) as typeof process.stdout.write);
	vi.spyOn(process, "exit").mockImplementation((code?: number | string | null): never => {
		throw new Exited(code);
	});
	const ended = await main([...args], {
		beforeActions: () => {
			throw new ReachedActions();
		},
	}).then(
		() => new Error("main() returned without answering"),
		(error: unknown) => error,
	);
	vi.restoreAllMocks();
	if (!(ended instanceof Exited)) throw ended;
	const output = chunks.join("");
	return { exit: ended.code, firstLine: output.split("\n")[0] ?? "", output };
}

describe("main() answers a first-token help or version before any action branch, for every root option", () => {
	const options = rootFlags();
	// The plain answers every row compares against, rendered once for the file.
	const references = new Map<string, Promise<Answer>>();
	const reference = (flag: "--help" | "--version") => {
		let answer = references.get(flag);
		if (answer === undefined) {
			answer = answerOf([flag]);
			references.set(flag, answer);
		}
		return answer;
	};

	it("the generated options are exactly the options the parser matches", () => {
		// parseArgs matches each option by an `arg === "<option>"` branch; --attach alone goes through its unknown-flag
		// table and is recognised by the shared isAttachToken. A new parser option without a table row fails here.
		const parserSource = readFileSync(join(__dirname, "..", "..", "src", "cli", "args.ts"), "utf8");
		const matched = new Set([...parserSource.matchAll(/arg === "(-[^"]+)"/g)].map((match) => match[1]));
		for (const meta of ["--", "--help", "-h", "--version", "-v"]) matched.delete(meta);
		if (isAttachToken("--attach")) matched.add("--attach");
		expect(new Set(options.map(([name]) => name))).toEqual(matched);
	});

	it.each(options.map((option) => [option.join(" "), option] as const))(
		"help first, then %s: help is the answer",
		async (_option, option) => {
			const args = ["--help", ...option];
			expect(classifyInvocation(args)).toBe("no_session");
			const help = await reference("--help");
			expect(await answerOf(args)).toMatchObject({ exit: 0, firstLine: help.firstLine });
		},
	);

	it.each(options.map((option) => [option.join(" "), option] as const))(
		"version first, then %s: the version is the answer",
		async (_option, option) => {
			const version = await reference("--version");
			expect(await answerOf(["--version", ...option])).toEqual(version);
		},
	);

	it("a help flag in a later position reaches the action branches (the command decides)", async () => {
		await expect(answerOf(["--hand", "--help"])).rejects.toBeInstanceOf(ReachedActions);
	});
});
