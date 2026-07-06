import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delaySlowStart, maybeWedge, parseFixtureOptions } from "./options.ts";
import { createFixtureServer } from "./sdk-server.ts";

async function main(): Promise<void> {
	const options = parseFixtureOptions(process.argv.slice(2));
	recordSpawn(options.spawnCounterFile);
	recordPid(options.pidFile);
	if (options.crashOnStart) {
		process.stderr.write("stdio fixture crash-on-start\n");
		process.exit(42);
	}
	if (options.crashAfterCalls === 0) {
		process.stderr.write("stdio fixture crash-after 0\n");
		process.exit(42);
	}
	if (maybeWedge(options)) return;
	await delaySlowStart(options);
	if (options.spawnGrandchild) {
		const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000);"], { stdio: "ignore" });
		process.stderr.write(`stdio fixture grandchild pid=${child.pid ?? "unknown"}\n`);
	}
	const server = createFixtureServer(options);
	await server.connect(new StdioServerTransport());
	process.stderr.write(`stdio fixture ready pid=${process.pid}\n`);
}

function recordSpawn(counterFile: string | undefined): void {
	if (counterFile === undefined) return;
	let current = 0;
	try {
		current = Number(readFileSync(counterFile, "utf8").trim()) || 0;
	} catch (error) {
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
	}
	writeFileSync(counterFile, `${current + 1}\n`);
}

function recordPid(pidFile: string | undefined): void {
	if (pidFile === undefined) return;
	writeFileSync(pidFile, `${process.pid}\n`);
}

function isNodeErrorCode(error: unknown, code: string): error is Error & { code: string } {
	return error instanceof Error && "code" in error && error.code === code;
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
