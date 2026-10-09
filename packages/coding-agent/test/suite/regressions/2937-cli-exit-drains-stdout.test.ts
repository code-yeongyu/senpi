import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const child = resolve(__dirname, "../../fixtures/print-then-exit-child.ts");
const throwingChild = resolve(__dirname, "../../fixtures/print-then-exit-throwing-child.ts");
const tsconfig = resolve(__dirname, "../../../../../tsconfig.json");
const ROWS = 4000;
const READER_DELAY_MS = 4000;

type Runtime = { readonly name: string; readonly command: string; readonly args: readonly string[] };

const runtimes: Runtime[] = [
	{ name: "node", command: process.execPath, args: ["--import", "tsx", child] },
	...(spawnSync("bun", ["--version"]).status === 0 ? [{ name: "bun", command: "bun", args: [child] }] : []),
];

function launch(runtime: Runtime) {
	return spawn(runtime.command, [...runtime.args, String(ROWS)], {
		env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function exited(process: ReturnType<typeof launch>): Promise<number | null> {
	return new Promise((done) => {
		if (process.exitCode !== null) done(process.exitCode);
		else process.once("exit", (code) => done(code));
	});
}

describe("senpi#2937 a print-then-exit command delivers all of its output", () => {
	it.each(runtimes)(
		"$name: a reader that starts 4 s late still receives every line, and the exit is 0",
		async (runtime) => {
			// given a reader that takes nothing for 4 s
			const process = launch(runtime);
			process.stdout.pause();
			const ended = new Promise<void>((done) => process.stdout.once("end", () => done()));
			await new Promise((done) => setTimeout(done, READER_DELAY_MS));

			// when it starts reading
			let text = "";
			process.stdout.setEncoding("utf8");
			process.stdout.on("data", (chunk: string) => {
				text += chunk;
			});
			process.stdout.resume();
			await ended;

			// then nothing is lost and the command still succeeds
			const lines = text.split("\n").filter((line) => line.length > 0);
			expect(lines).toHaveLength(ROWS + 1);
			expect(lines[0]).toBe("header");
			expect(lines.at(-1)).toBe(`row ${ROWS - 1} ${"x".repeat(80)}`);
			expect(await exited(process)).toBe(0);
		},
		60_000,
	);

	it.each(runtimes)(
		"$name: a reader that closes early ends the command instead of hanging it",
		async (runtime) => {
			// given a reader that takes the first chunk and closes the pipe
			const process = launch(runtime);
			const firstChunk = new Promise<void>((done) => process.stdout.once("data", () => done()));
			await firstChunk;
			process.stdout.destroy();

			// when the command finishes printing
			const code = await exited(process);

			// then it has exited on its own and successfully, not by crashing on the closed pipe
			expect(code).toBe(0);
		},
		20_000,
	);

	it("writes what was printed before a printing function throws, and the error still reaches the caller", () => {
		// given a print that writes a line and then throws
		// when it runs under printThenExit
		const result = spawnSync(process.execPath, ["--import", "tsx", throwingChild], {
			env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
			encoding: "utf8",
		});

		// then the line is not lost and the caller sees the error
		expect(result.stdout).toBe("before the failure\n");
		expect(result.stderr).toContain("caught: print failed");
		expect(result.status).toBe(3);
	});
});
