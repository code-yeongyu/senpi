export interface FixtureOptions {
	toolCount: number;
	slowStartMs: number;
	crashAfterCalls: number | null;
	wedge: boolean;
	isErrorTool: boolean;
	hugeOutput: { bytes: number; lines: number } | null;
	emitListChanged: boolean;
	instructions: string | undefined;
	port: number;
	expireSession: boolean;
	bearerToken: string | undefined;
}

export function parseFixtureOptions(argv: readonly string[]): FixtureOptions {
	const options: FixtureOptions = {
		toolCount: readIntegerFlag(argv, "--tools", 1),
		slowStartMs: readIntegerFlag(argv, "--slow-start", 0),
		crashAfterCalls: readOptionalIntegerFlag(argv, "--crash-after"),
		wedge: argv.includes("--wedge"),
		isErrorTool: argv.includes("--iserror-tool"),
		hugeOutput: readHugeOutput(argv),
		emitListChanged: argv.includes("--emit-list-changed"),
		instructions: readStringFlag(argv, "--instructions"),
		port: readIntegerFlag(argv, "--port", 0),
		expireSession: argv.includes("--expire-session"),
		bearerToken: readStringFlag(argv, "--bearer"),
	};
	validateArgs(argv, options);
	return options;
}

export function maybeWedge(options: FixtureOptions): boolean {
	if (!options.wedge) return false;
	process.stderr.write("fixture wedge enabled; accepting process lifetime without MCP replies\n");
	process.stdin.resume();
	setInterval(() => undefined, 60_000).unref();
	return true;
}

export async function delaySlowStart(options: FixtureOptions): Promise<void> {
	if (options.slowStartMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, options.slowStartMs));
	}
}

function readIntegerFlag(argv: readonly string[], name: string, fallback: number): number {
	const value = readStringFlag(argv, name);
	return value === undefined ? fallback : parseNonNegativeInteger(name, value);
}

function readOptionalIntegerFlag(argv: readonly string[], name: string): number | null {
	const value = readStringFlag(argv, name);
	return value === undefined ? null : parseNonNegativeInteger(name, value);
}

function parseNonNegativeInteger(name: string, value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return Number(value);
}

function readStringFlag(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function readHugeOutput(argv: readonly string[]): FixtureOptions["hugeOutput"] {
	const value = readStringFlag(argv, "--huge-output-tool");
	if (value === undefined) return null;
	const [bytesRaw, linesRaw] = value.split("/");
	return {
		bytes: parseNonNegativeInteger("--huge-output-tool bytes", bytesRaw ?? ""),
		lines: parseNonNegativeInteger("--huge-output-tool lines", linesRaw ?? "1"),
	};
}

function validateArgs(argv: readonly string[], options: FixtureOptions): void {
	const valued = new Set([
		"--tools",
		"--slow-start",
		"--crash-after",
		"--huge-output-tool",
		"--instructions",
		"--port",
		"--bearer",
	]);
	const bare = new Set(["--wedge", "--iserror-tool", "--emit-list-changed", "--expire-session"]);
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (valued.has(arg)) {
			index++;
			continue;
		}
		if (bare.has(arg)) continue;
		throw new Error(`unknown fixture argument: ${arg}`);
	}
	if (options.toolCount < 0) {
		throw new Error("--tools must be non-negative");
	}
}
