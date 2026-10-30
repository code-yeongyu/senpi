// One SC-LIVE run's sandbox: the fixture task repo as the work dir, the trusted PreToolUse/PostToolUse trace hooks, the
// MCP stdio fixture server, the with-deps example extension and a sub-agent task component. The model side (fake model
// server or the pinned real provider) is reached through the recording proxy (recording-proxy.mjs) for O3/O4.
import { spawnSync } from "node:child_process";
import { cpSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, repoRoot, resolveBun } from "../../../../scripts/lib/common.mjs";
import { hermeticEnv } from "../../../../scripts/lib/mock-loop-support.mjs";

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MCP_SERVER = "fxstdio";
/** The EQ task fixture: a deterministic stand-in for the sub-agent component, used only by the self-test. */
export const SELF_TEST_TASK_EXTENSION = join(FIXTURE, "..", "..", "fused-equivalence", "fixtures", "task-tool.mjs");

/** Terminal-identity variables the CLI renders into its prompt; pinned so every host sees the same. */
const TERMINAL_ENV = ["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "TERM_SESSION_ID", "ITERM_SESSION_ID"];

/**
 * @param {{ label: string, taskExtension: string, extraEnv?: Record<string, string> }} options
 * @returns {{ box: ReturnType<typeof makeSandbox>, env: Record<string, string>, extensions: string[],
 *   hookTrace: string }}
 */
export function setUpSandbox({ label, taskExtension, extraEnv = {} }) {
	const box = makeSandbox(`live-${label}`);
	cpSync(join(FIXTURE, "repo"), box.cwd, { recursive: true });
	const hookTrace = join(box.dir, "hook-trace.jsonl");
	const hookCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(FIXTURE, "hooks", "hook.mjs"))} ${JSON.stringify(hookTrace)}`;
	// The CLI resolves its cwd through symlinks (macOS /var -> /private/var); the hooks file must name that same path.
	const hooks = spawnSync(
		resolveBun().command,
		[join(FIXTURE, "hooks", "write-hooks.ts"), realpathSync(box.cwd), hookCommand],
		{
			encoding: "utf8",
		},
	);
	if (hooks.status !== 0) throw new Error(`write-hooks.ts failed: ${hooks.stderr}`);
	const mcpFixtures = join(repoRoot(), "packages", "coding-agent", "test", "mcp", "fixtures");
	const mcp = {
		mcpServers: {
			[MCP_SERVER]: {
				command: resolveBun().command,
				args: [join(mcpFixtures, "stdio-server.ts"), "--tools", "1"],
				lifecycle: "eager",
			},
		},
	};
	writeFileSync(join(box.agentDir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
	const env = hermeticEnv(box.env);
	for (const name of TERMINAL_ENV) delete env[name];
	Object.assign(env, { TERM: "xterm-256color" }, extraEnv);
	const extensions = [
		join(repoRoot(), "packages", "coding-agent", "examples", "extensions", "with-deps"),
		taskExtension,
	];
	return { box, env, extensions, hookTrace };
}
