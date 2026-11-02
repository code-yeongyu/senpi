// Windows module-job body for the kill-before-heartbeat test (senpi#3566 todo 4): starts a long command that waits on a
// named event and returns its pid at once, leaving the command running inside the tool child's job.
import { spawn } from "node:child_process";

export function startGated(input: { readonly params: { readonly marker: string; readonly gate: string } }) {
	// cmd.exe parses its own command line, not the C runtime's quoting Node applies to an argument array: the line goes
	// verbatim, wrapped for /s.
	const command = spawn(
		"cmd.exe",
		["/d", "/s", "/c", `"echo.> "${input.params.marker}" && waitfor ${input.params.gate} /t 300"`],
		{ stdio: "ignore", windowsVerbatimArguments: true },
	);
	return { content: [{ type: "text", text: String(command.pid) }], details: { pid: command.pid } };
}

export function sleepFor(input: { readonly params: { readonly ms: number } }) {
	return new Promise((resolveSleep) =>
		setTimeout(
			() => resolveSleep({ content: [{ type: "text", text: "slept" }], details: { pid: process.pid } }),
			input.params.ms,
		),
	);
}
