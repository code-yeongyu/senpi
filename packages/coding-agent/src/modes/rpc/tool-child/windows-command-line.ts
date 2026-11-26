/**
 * One Windows command line from an argv, for `CreateProcessW` (senpi#3566, plan todo 4: the breakaway shim). Windows
 * passes a single string; the program's C runtime splits it back with the MSVC rules, so each argument is quoted such
 * that the split returns it unchanged: spaces, tabs and quotes force quoting, a quote is escaped as `\"`, and
 * backslashes are doubled only when they precede a quote (inside the argument or before the closing quote).
 */
export function quoteWindowsArgument(argument: string): string {
	if (argument !== "" && !/[\s"]/.test(argument)) return argument;
	let quoted = '"';
	let backslashes = 0;
	for (const character of argument) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}
		if (character === '"') {
			quoted += "\\".repeat(backslashes * 2 + 1);
			quoted += '"';
		} else {
			quoted += "\\".repeat(backslashes);
			quoted += character;
		}
		backslashes = 0;
	}
	quoted += "\\".repeat(backslashes * 2);
	return `${quoted}"`;
}

export function windowsCommandLine(argv: readonly string[]): string {
	return argv.map(quoteWindowsArgument).join(" ");
}
