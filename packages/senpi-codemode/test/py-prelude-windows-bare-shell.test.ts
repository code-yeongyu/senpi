import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hasPython3 } from "./py-kernel/fixtures.ts";

const execute = promisify(execFile);
const prelude = fileURLToPath(new URL("../src/kernels/py/prelude.py", import.meta.url));

// Loads the prelude as a module (its main() never runs) and drives the Windows helpers with a host-named bash.
const probe = String.raw`
import importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location("senpi_prelude_probe", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)
git_bash = r"C:\Program Files\Git\bin\bash.exe"
resolve = lambda name: mod._windows_bare_shell_path(name, git_bash)
class Recorder:
    def __init__(self, args, *rest, **kwargs):
        self.args = args
popen = mod._bare_shell_popen(Recorder, resolve)
os.environ["SENPI_KERNEL_BASH"] = git_bash
mod._install_windows_bare_shell_resolution()
installed = {"envRemoved": "SENPI_KERNEL_BASH" not in os.environ, "posixKeepsDefault": mod._kernel_bash}
mod.os = types.SimpleNamespace(name="nt")
mod._shell = lambda command, argv=None: [command, argv]
mod._kernel_bash = git_bash
magic_named = mod._magic_cell("bash", "", "echo hi")
mod._kernel_bash = None
magic_none = mod._magic_cell("bash", "", "echo hi")
print("RESULT " + json.dumps({
    "named": mod._windows_bare_shell_path("sh", git_bash),
    "noBash": mod._windows_bare_shell_path("bash", None),
    "notAShell": mod._windows_bare_shell_path("python", git_bash),
    "argv": mod._with_windows_bare_shell(["bash", "-lc", "echo hi"], resolve),
    "commandLine": mod._with_windows_bare_shell("bash -lc 'echo hi'", resolve),
    "absolute": mod._with_windows_bare_shell([git_bash, "-c", "x"], resolve),
    "other": mod._with_windows_bare_shell(["git", "status"], resolve),
    "popen": [
        popen(["bash", "-c", "x"], shell=False).args,
        popen("bash -c x", shell=True).args,
        popen(["bash", "-c", "x"], executable="other.exe").args,
    ],
    "installed": installed,
    "magicNamed": magic_named,
    "magicNone": magic_none,
}))
`;

describe.skipIf(!(await hasPython3()))("Python prelude bare bash/sh on Windows (omo#10894)", () => {
	it("runs the host-named bash tool's bash for a bare bash/sh and %%bash, with the bash tool's -c launch", async () => {
		const { stdout } = await execute("python3", ["-c", probe, prelude], { timeout: 20_000 });
		const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
		if (line === undefined) throw new Error(`missing result: ${stdout}`);
		const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
		expect(JSON.parse(line.slice("RESULT ".length))).toEqual({
			named: gitBash,
			noBash: null,
			notAShell: null,
			argv: [gitBash, "-lc", "echo hi"],
			commandLine: `"${gitBash}" -lc 'echo hi'`,
			absolute: [gitBash, "-c", "x"],
			other: ["git", "status"],
			popen: [[gitBash, "-c", "x"], "bash -c x", ["bash", "-c", "x"]],
			// The name is consumed so cells and their children never see it; off Windows nothing is patched.
			installed: { envRemoved: true, posixKeepsDefault: null },
			magicNamed: ["echo hi", [gitBash, "-c", "echo hi"]],
			magicNone: ["echo hi", null],
		});
	});
});
