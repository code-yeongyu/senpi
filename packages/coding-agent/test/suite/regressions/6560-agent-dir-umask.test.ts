/**
 * senpi#6560: the RPC host takes the agent dir as its key root and refuses one that group or others can write
 * (`rpc-public-key.ts`). Product paths created the agent dir with a plain `mkdir -p`, so under umask 0002 the
 * first senpi command left it 0775 and every later host failed to publish its key (`unsafe_key_record`).
 * Guards the key-root security contract: a dir senpi creates is 0700 whatever the umask, and a loose dir it did
 * not create is still refused.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recordLegacyPiAgentDirCopy } from "../../../src/migrations-state.ts";
import { checkRpcKeyDirectory, RpcPublicEndpoint } from "../../../src/modes/rpc/rpc-public-key.ts";
import { ensureAgentDir } from "../../../src/utils/ensure-agent-dir.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = resolve(import.meta.dirname, "../../../src/cli.ts");
const sourceResolverUrl = pathToFileURL(
	resolve(import.meta.dirname, "../../../src/experimental/source-resolver.ts"),
).href;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-6560-"));
	roots.push(root);
	return root;
}

function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}

function underUmask<T>(umask: number, run: () => T): T {
	const previous = process.umask(umask);
	try {
		return run();
	} finally {
		process.umask(previous);
	}
}

/** Runs the real CLI with `umask` as its process umask (a child inherits it at spawn) and a fresh agent dir. */
function runCliUnderUmask(
	umask: number,
	agentDir: string,
	home: string,
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = underUmask(umask, () =>
			spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "--help"], {
				cwd: home,
				env: { ...hostSpawnEnv(), HOME: home, SENPI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
				stdio: ["ignore", "ignore", "pipe"],
			}),
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (code) => resolvePromise({ code, stderr }));
	});
}

async function publishKey(agentDir: string): Promise<void> {
	const endpoint = new RpcPublicEndpoint(agentDir, join(agentDir, "rpc", "rpc.sock"));
	try {
		await endpoint.publish();
	} finally {
		await endpoint.dispose();
	}
}

// POSIX only: the key-root rule reads POSIX mode bits and `process.umask` has no effect on Windows.
describe.skipIf(process.platform === "win32")("agent dir created under any umask (senpi#6560)", () => {
	it.each([0o002, 0o022, 0o077])(
		"#given umask %o and no agent dir #when the CLI starts #then the agent dir is 0700 and the RPC host publishes its key there",
		async (umask) => {
			const root = scratchRoot();
			const home = join(root, "home");
			mkdirSync(home);
			const agentDir = join(home, ".senpi", "agent");

			const run = await runCliUnderUmask(umask, agentDir, home);

			expect(run.code, run.stderr).toBe(0);
			expect(modeOf(agentDir)).toBe(0o700);
			expect(modeOf(join(home, ".senpi"))).toBe(0o700);
			await expect(publishKey(agentDir)).resolves.toBeUndefined();
		},
		60_000,
	);

	it("#given umask 0002 #when the migrations state is first written #then the agent dir it creates is 0700", () => {
		const agentDir = join(scratchRoot(), "agent");

		underUmask(0o002, () => recordLegacyPiAgentDirCopy(agentDir, 0));

		expect(modeOf(agentDir)).toBe(0o700);
	});

	it("#given a group-writable agent dir senpi did not create #when senpi ensures it #then it is left as is and the host still refuses it", async () => {
		const agentDir = join(scratchRoot(), "agent");
		underUmask(0o002, () => mkdirSync(agentDir));

		ensureAgentDir(agentDir);

		expect(modeOf(agentDir)).toBe(0o775);
		await expect(checkRpcKeyDirectory(agentDir)).rejects.toMatchObject({ code: "unsafe_key_record" });
	});
});
