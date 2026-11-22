import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hasPython3 } from "./py-kernel/fixtures.ts";

const execute = promisify(execFile);
const prelude = fileURLToPath(new URL("../src/kernels/py/prelude.py", import.meta.url));

const probe = String.raw`
import json, runpy, sys
ns = runpy.run_path(sys.argv[1])
shell_path = ns["_windows_bare_shell_path"]
with_shell = ns["_with_windows_bare_shell"]
git_bash = r"C:\Program Files\Git\bin\bash.exe"
wsl = r"C:\WINDOWS\System32\bash.exe"
git_first = lambda name: git_bash if name in ("bash", "sh") else None
wsl_only = lambda name: wsl
resolve = lambda name: shell_path(name, git_first, r"C:\Windows")
class Recorder:
    def __init__(self, args, *rest, **kwargs):
        self.args = args
popen = ns["_bare_shell_popen"](Recorder, resolve)
popen_args = [
    popen(["bash", "-c", "x"], shell=False).args,
    popen("bash -c x", shell=True).args,
    popen(["bash", "-c", "x"], executable="other.exe").args,
]
print("RESULT " + json.dumps({
    "gitFirst": shell_path("bash", git_first, r"C:\Windows"),
    "wslOnly": shell_path("bash", wsl_only, r"C:\Windows"),
    "notAShell": shell_path("python", git_first, r"C:\Windows"),
    "argv": with_shell(["bash", "-lc", "echo hi"], resolve),
    "commandLine": with_shell("bash -lc 'echo hi'", resolve),
    "absolute": with_shell([git_bash, "-c", "x"], resolve),
    "other": with_shell(["git", "status"], resolve),
    "popen": popen_args,
}))
`;

describe.skipIf(!(await hasPython3()))("Python prelude bare bash/sh on Windows (omo#10894)", () => {
	it("resolves a bare bash to the PATH-first non-WSL match and leaves everything else alone", async () => {
		const { stdout } = await execute("python3", ["-c", probe, prelude], { timeout: 20_000 });
		const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
		if (line === undefined) throw new Error(`missing result: ${stdout}`);
		const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
		expect(JSON.parse(line.slice("RESULT ".length))).toEqual({
			gitFirst: gitBash,
			wslOnly: null,
			notAShell: null,
			argv: [gitBash, "-lc", "echo hi"],
			commandLine: `"${gitBash}" -lc 'echo hi'`,
			absolute: [gitBash, "-c", "x"],
			other: ["git", "status"],
			popen: [[gitBash, "-c", "x"], "bash -c x", ["bash", "-c", "x"]],
		});
	});
});
