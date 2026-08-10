import { dirname, join } from "node:path";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";

const env = new NodeExecutionEnv({
	cwd: process.cwd(),
	shellPath: join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
});
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
process.env[pathKey] = dirname(process.execPath);

const result = await env.exec(`"${process.execPath}" -e "require('node:net').createServer().listen(0)"`, {
	timeout: 1,
});
if (result.ok || result.error.code !== "timeout") {
	throw new Error(`Expected timeout result, received ${JSON.stringify(result)}`);
}
