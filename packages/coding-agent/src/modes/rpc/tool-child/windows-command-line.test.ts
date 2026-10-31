// senpi#3566 todo 4 (Windows half): the breakaway shim's command line round-trips every argument through the MSVC
// splitting rules. The splitter below is an independent reading of those rules; the win32 suite repeats the check
// against a real process's argv.
import { describe, expect, it } from "vitest";
import { quoteWindowsArgument, windowsCommandLine } from "./windows-command-line.ts";

/** MSVC argv splitting (the C runtime's rules for a program's own command line, past argv[0]). */
function splitMsvc(commandLine: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuotes = false;
	let started = false;
	let index = 0;
	while (index < commandLine.length) {
		const character = commandLine[index] ?? "";
		if (character === "\\") {
			let run = 0;
			while (commandLine[index] === "\\") {
				run += 1;
				index += 1;
			}
			if (commandLine[index] === '"') {
				current += "\\".repeat(Math.floor(run / 2));
				if (run % 2 === 1) {
					current += '"';
					index += 1;
				}
			} else {
				current += "\\".repeat(run);
			}
			started = true;
			continue;
		}
		if (character === '"') {
			if (inQuotes && commandLine[index + 1] === '"') {
				current += '"';
				index += 2;
				continue;
			}
			inQuotes = !inQuotes;
			started = true;
			index += 1;
			continue;
		}
		if (!inQuotes && (character === " " || character === "\t")) {
			if (started) args.push(current);
			current = "";
			started = false;
			index += 1;
			continue;
		}
		current += character;
		started = true;
		index += 1;
	}
	if (started) args.push(current);
	return args;
}

const CASES = [
	"plain",
	"",
	"with space",
	"tab\there",
	'a"quote',
	'"leading and trailing"',
	"trailing\\",
	"trailing space \\",
	"C:\\Program Files\\x\\",
	'back\\"slash-quote',
	'\\\\"double',
	"\\\\server\\share",
	"unicode é ✓",
];

describe("windowsCommandLine", () => {
	it("round-trips every argument through the MSVC splitting rules", () => {
		expect(splitMsvc(windowsCommandLine(CASES))).toEqual(CASES);
	});

	it("leaves simple arguments unquoted and quotes the empty argument", () => {
		expect(quoteWindowsArgument("plain")).toBe("plain");
		expect(quoteWindowsArgument("C:\\tools\\x.exe")).toBe("C:\\tools\\x.exe");
		expect(quoteWindowsArgument("")).toBe('""');
	});

	it("doubles backslashes only before a quote", () => {
		expect(quoteWindowsArgument("dir with space\\")).toBe('"dir with space\\\\"');
		expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
	});
});
