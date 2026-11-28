/**
 * senpi#6560: the RPC host takes the agent dir as its key root and refuses one that group or others can write
 * (`rpc-public-key.ts`). Product paths created the agent dir with a plain `mkdir -p`, so under umask 0002 the
 * first senpi command left it 0775 and every later host failed to publish its key (`unsafe_key_record`).
 * Guards the key-root security contract: a dir senpi creates is 0700 whatever the umask, and a loose dir it did
 * not create is still refused. The launcher-level ordering (`cli.ts` and `main()` call `ensureAgentDir` before anything
 * writes under the agent dir) is proven by the real-CLI QA on the PR: a source CLI spawn takes 10-30 s on a loaded
 * host, past this suite's timeout.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { recordLegacyPiAgentDirCopy } from "../../../src/migrations-state.ts";
import { checkRpcKeyDirectory, RpcPublicEndpoint } from "../../../src/modes/rpc/rpc-public-key.ts";
import { ensureAgentDir } from "../../../src/utils/ensure-agent-dir.ts";

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
		"#given umask %o and no agent dir #when senpi ensures it #then it and the parent it created are 0700 and the host publishes its key",
		async (umask) => {
			const parent = join(scratchRoot(), "config");
			const agentDir = join(parent, "agent");

			underUmask(umask, () => ensureAgentDir(agentDir));

			expect(modeOf(parent)).toBe(0o700);
			expect(modeOf(agentDir)).toBe(0o700);
			await expect(publishKey(agentDir)).resolves.toBeUndefined();
		},
	);

	it.each([
		["the migrations state", (agentDir: string) => recordLegacyPiAgentDirCopy(agentDir, 0)],
		["the project trust store", (agentDir: string) => new ProjectTrustStore(agentDir).get(agentDir)],
	])(
		"#given umask 0002 and no agent dir #when %s is first touched #then the agent dir it creates is 0700",
		(_, write) => {
			const agentDir = join(scratchRoot(), "agent");

			underUmask(0o002, () => write(agentDir));

			expect(modeOf(agentDir)).toBe(0o700);
		},
	);

	// Neither the launcher's ensureAgentDir nor the trust store's mkdir re-modes an existing dir: a loose one stays
	// refused with its chmod hint instead of being silently tightened.
	it.each([
		["senpi ensures it", (agentDir: string) => ensureAgentDir(agentDir)],
		["the project trust store touches it", (agentDir: string) => new ProjectTrustStore(agentDir).get(agentDir)],
	])(
		"#given a group-writable agent dir senpi did not create #when %s #then it is left as is and the host still refuses it",
		async (_, touch) => {
			const agentDir = join(scratchRoot(), "agent");
			underUmask(0o002, () => mkdirSync(agentDir));

			touch(agentDir);

			expect(modeOf(agentDir)).toBe(0o775);
			await expect(checkRpcKeyDirectory(agentDir)).rejects.toMatchObject({ code: "unsafe_key_record" });
		},
	);
});
