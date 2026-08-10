import { dirname } from "node:path";
import { PipeFallbackSession } from "../../src/pipe-fallback.ts";

const session = new PipeFallbackSession({
	command: process.execPath,
	args: ["-e", "process.stdin.resume()"],
});
session.start();

const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
process.env[pathKey] = dirname(process.execPath);

const kill = session.kill();
if (!kill.ok) {
	throw new Error(kill.note);
}

const exit = await session.waitExit();
if (exit.error) {
	throw new Error(exit.error.message);
}
