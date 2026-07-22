const KNOWN_COMMANDS = new Set([
	"--run",
	"--self-test",
	"--with-mcp-tool",
	"--with-reasoning",
	"--with-text-tool-leak",
	"--with-tool",
	"--with-truncated-text-tool-leak",
]);

export function dispatchExitCode(argv) {
	return KNOWN_COMMANDS.has(argv[0]) ? 0 : 2;
}

export function flagValue(argv, name) {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

export function parseToolArgs(argv) {
	const raw = flagValue(argv, "--tool-args");
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch (error) {
		throw new Error(`--tool-args must be a JSON object: invalid JSON (${safeErrorReason(error)})`);
	}
	throw new Error("--tool-args must be a JSON object");
}

export function positionalAfter(argv, command) {
	const start = argv.indexOf(command);
	if (start < 0) return undefined;
	const valuedFlags = new Set(["--api", "--tool-name", "--tool-args", "--evidence"]);
	for (let index = start + 1; index < argv.length; index++) {
		const argument = argv[index];
		if (valuedFlags.has(argument)) {
			index++;
			continue;
		}
		if (!argument.startsWith("--")) return argument;
	}
	return undefined;
}

function safeErrorReason(error) {
	return error instanceof Error ? error.name : typeof error;
}
