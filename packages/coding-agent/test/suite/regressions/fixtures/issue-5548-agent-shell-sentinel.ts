// Run under Bun with SENPI_RPC_INTERNAL_KEY_STDIN=1 and a 32-byte key on stdin, the way a supervisor launches a host
// child (senpi#5548). The real bootstrap consumes the key and deletes the sentinel; the agent shell this host then starts
// runs a descendant that boots the same bootstrap with no key, which must start normally.
import "../../../../src/modes/rpc/internal-bootstrap.ts";
import { fileURLToPath } from "node:url";
import { loadPty } from "../../../../src/core/extensions/builtin/terminal/pty.lazy.ts";

const bootstrap = fileURLToPath(new URL("../../../../src/modes/rpc/internal-bootstrap.ts", import.meta.url));
const boot = `await import(${JSON.stringify(bootstrap)}); console.log("booted")`;
const PROBE = `"$SENPI_5548_BUN" -e '${boot}' </dev/null 2>&1; echo "status=$? sentinel=${"$"}{SENPI_RPC_INTERNAL_KEY_STDIN-unset}"`;

const pty = await loadPty();
type Dependencies = ConstructorParameters<typeof pty.TerminalSession>[1];
const BACKENDS: ReadonlyArray<readonly [string, Dependencies]> = [
	["native", { env: {} }],
	["bun", { env: { SENPI_BUN_TERMINAL: "1" } }],
	["pipe-fallback", { env: { SENPI_PTY_FORCE_PIPE: "1" } }],
];
const shells: Record<string, string[]> = {};
for (const [backend, dependencies] of BACKENDS) {
	// The terminal tool hands its session an explicit environment built from the live process.env (tools/spawn.ts).
	const env = { ...process.env, SENPI_5548_BUN: process.execPath };
	const session = new pty.TerminalSession({ command: "/bin/sh", args: ["-c", PROBE], env }, dependencies);
	const chunks: Uint8Array[] = [];
	session.onData((chunk) => chunks.push(chunk));
	session.start();
	await session.waitExit();
	shells[backend] = Buffer.concat(chunks).toString("utf8").replace(/\r/g, "").trim().split("\n");
}
console.log(JSON.stringify({ hostSentinel: process.env.SENPI_RPC_INTERNAL_KEY_STDIN ?? null, shells }));
