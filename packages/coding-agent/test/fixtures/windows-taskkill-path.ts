import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { killProcessTree } from "../../src/utils/shell.ts";

const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
if (child.pid === undefined) {
	throw new Error("Expected the child process to have a pid");
}

const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
process.env[pathKey] = dirname(process.execPath);
killProcessTree(child.pid);

await new Promise<void>((resolve, reject) => {
	child.once("error", reject);
	child.once("close", () => resolve());
});
