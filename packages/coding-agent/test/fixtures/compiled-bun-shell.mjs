// Compiled with `bun build --compile` by compiled-bun-shell-commands.test.ts. It stands in for the
// compiled engine: it runs one command with the environment getShellEnv() builds, either through
// Bun Shell (what an eval cell's Bun.$ does) or through /bin/sh (what the bash tool does), and prints
// the result. If a `bun` in that command re-runs this executable instead of Bun, the re-run announces
// itself, which is the phantom-agent failure.
import { getShellEnv } from "../../src/utils/shell.ts";

if (process.env.FIXTURE_ENGINE_PARENT !== undefined) {
	console.log("ENGINE-ENTRY-RAN");
	process.exit(0);
}

const command = process.env.FIXTURE_COMMAND ?? "";
const cwd = process.env.FIXTURE_CWD ?? process.cwd();
const env = { ...getShellEnv(), FIXTURE_ENGINE_PARENT: String(process.pid) };
const shell = process.env.FIXTURE_SHELL === "sh" ? Bun.$`/bin/sh -c ${command}` : Bun.$`${{ raw: command }}`;
const result = await shell.cwd(cwd).env(env).nothrow().quiet();
console.log(
	JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }),
);
