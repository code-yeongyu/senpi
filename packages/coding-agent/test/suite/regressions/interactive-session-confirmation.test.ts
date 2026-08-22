import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { promptConfirm } from "../../../src/main.ts";

const originalStdin = process.stdin;
const originalStdout = process.stdout;

async function confirmWithInput(input: string | undefined): Promise<boolean> {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
	Object.defineProperty(process, "stdout", { configurable: true, value: stdout });

	const result = promptConfirm("Continue?");
	if (input === undefined) stdin.end();
	else stdin.end(`${input}\n`);
	return result;
}

afterEach(() => {
	Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
	Object.defineProperty(process, "stdout", { configurable: true, value: originalStdout });
});

describe("interactive session confirmation", () => {
	test.each([
		["y", true],
		["yes", true],
		["n", false],
		["", false],
		[undefined, false],
	] as const)("returns %s => %s", async (input, expected) => {
		await expect(confirmWithInput(input)).resolves.toBe(expected);
	});
});
