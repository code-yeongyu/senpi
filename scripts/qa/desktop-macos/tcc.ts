import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateDesktopEngine } from "@code-yeongyu/senpi-desktop-engine";
import { workDir } from "./fixtures.ts";
import { type ScenarioResult, toolError, withSession } from "./scenario.ts";

/**
 * Spawns argv[1..] with TCC responsibility disclaimed (`responsibility_spawnattrs_setdisclaim`, the attribute
 * terminals use so a child answers for itself), so TCC evaluates the child's own identity instead of the
 * launcher's grants. The engine binary holds no Screen Recording grant of its own.
 */
const DISCLAIM_PY = `import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
attr = ctypes.c_void_p()
assert libc.posix_spawnattr_init(ctypes.byref(attr)) == 0
assert libc.responsibility_spawnattrs_setdisclaim(ctypes.byref(attr), 1) == 0
argv = (ctypes.c_char_p * len(sys.argv))(*[a.encode() for a in sys.argv[1:]], None)
env = (ctypes.c_char_p * (len(os.environ) + 1))(*[f"{k}={v}".encode() for k, v in os.environ.items()], None)
pid = ctypes.c_int()
assert libc.posix_spawn(ctypes.byref(pid), sys.argv[1].encode(), None, ctypes.byref(attr), argv, env) == 0
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid.value, 0)[1]))
`;

/** A `computer.enginePath` that starts the located engine as its own TCC-responsible process. */
function disclaimedEngine(): { readonly wrapper: string; readonly engine: string } {
	const located = locateDesktopEngine();
	if (located.path === null) throw new Error(located.diagnostic.message);
	const helper = join(workDir, "disclaim.py");
	const wrapper = join(workDir, "disclaimed-engine.sh");
	writeFileSync(helper, DISCLAIM_PY);
	writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/python3 '${helper}' '${located.path}' "$@"\n`);
	chmodSync(wrapper, 0o755);
	return { wrapper, engine: located.path };
}

/**
 * `tcc-diagnostic`: the same full stack, but the engine answers to TCC for itself instead of inheriting the
 * launcher's Screen Recording grant, so a screenshot must fail naming the executable identity TCC evaluated.
 */
export async function tccDiagnostic(): Promise<ScenarioResult> {
	const { wrapper, engine } = disclaimedEngine();
	return withSession({ enginePath: wrapper }, async (session) => {
		const outcome = await session.call({ action: "call", chain: [{ method: "screenshot" }] });
		const message = toolError(outcome) ?? "";
		const identity = /TCC identity: executable=([^,)]+)/.exec(message)?.[1] ?? null;
		const facts = { launcher: "engine spawned with TCC responsibility disclaimed", engine, message, identity };
		const pass = outcome.isError && message.includes("TCC identity: executable=") && identity === engine;
		return { scenario: "tcc-diagnostic", pass, facts };
	});
}
