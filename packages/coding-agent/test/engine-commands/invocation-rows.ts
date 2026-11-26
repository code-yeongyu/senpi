/** Invocations the classifier exempts: they never read the private descriptor table. */
export const EXEMPT: ReadonlyArray<readonly string[]> = [
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

/** Invocations the classifier sends through the table: an unreadable table refuses them. */
export const REFUSED: ReadonlyArray<readonly string[]> = [
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

/** Help in a later position keeps the owner's rule: the command's class decides. */
export const HELP_LATER: ReadonlyArray<readonly string[]> = [
	["--hand", "--help"],
	["--headless", "--help"],
	["--export", "x", "--help"],
	["-p", "x", "--help"],
	["--mode", "rpc", "--help"],
];

/** Table shapes that do not parse. */
export const UNREADABLE: ReadonlyArray<readonly [string, string]> = [
	["not json", "garbage"],
	["cut short", '{"presenter":4,'],
	["over the read limit", `{"pad":"${"x".repeat(4200)}","api-key":5}`],
];
