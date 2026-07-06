import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delaySlowStart, maybeWedge, parseFixtureOptions } from "./options.ts";
import { createFixtureServer } from "./sdk-server.ts";

async function main(): Promise<void> {
	const options = parseFixtureOptions(process.argv.slice(2));
	if (maybeWedge(options)) return;
	await delaySlowStart(options);
	const server = createFixtureServer(options);
	await server.connect(new StdioServerTransport());
	process.stderr.write(`stdio fixture ready pid=${process.pid}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
