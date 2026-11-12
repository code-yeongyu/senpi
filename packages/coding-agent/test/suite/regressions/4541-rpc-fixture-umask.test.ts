/**
 * senpi#4541: the RPC host refuses a key root (`<agentDir>` and `<agentDir>/rpc`) that is writable by group or
 * others (`rpc-public-key.ts`). A fixture that builds that path for a real host with a plain `mkdir` gets the
 * runner's umask, so under umask 0002 the directory is 0775, the host never publishes its key, and every case on
 * that fixture fails for a machine reason. Each fixture below must leave its key root acceptable whatever the umask.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkRpcKeyDirectory } from "../../../src/modes/rpc/rpc-public-key.ts";
import { sandbox, sweepSandboxes } from "../../helpers/rpc-host-daemon-sandbox.ts";
import { endpointScratch, sweepEndpointScratches } from "../../helpers/rpc-host-endpoint-scratch.ts";
import { scratch } from "../../helpers/rpc-socket-host-support.ts";
import { resolveQuarantineAgentDir } from "../../support/quarantine.ts";
import { hostCliSandbox, sweepHostCliSandboxes } from "../host-cli-support.ts";

async function underGroupWritableUmask<T>(build: () => Promise<T> | T): Promise<T> {
	const previous = process.umask(0o002);
	try {
		return await build();
	} finally {
		process.umask(previous);
	}
}

async function expectKeyRootAccepted(agentDir: string): Promise<void> {
	await expect(checkRpcKeyDirectory(agentDir)).resolves.toBeUndefined();
	const rpc = join(agentDir, "rpc");
	if (existsSync(rpc)) await expect(checkRpcKeyDirectory(rpc)).resolves.toBeUndefined();
}

// POSIX only: the key-root rule reads POSIX mode bits and `process.umask` has no effect on Windows.
describe.skipIf(process.platform === "win32")("RPC host fixtures under umask 0002 (senpi#4541)", () => {
	afterEach(async () => {
		await sweepHostCliSandboxes();
		await sweepSandboxes();
		await sweepEndpointScratches();
	});

	test("#given umask 0002 #when hostCliSandbox builds its agent dir #then the host accepts it as a key root", async () => {
		const qa = await underGroupWritableUmask(() => hostCliSandbox("umask"));
		await expectKeyRootAccepted(qa.agentDir);
	});

	test("#given umask 0002 #when the socket-host scratch builds its agent dir #then the host accepts it as a key root", async () => {
		const qa = await underGroupWritableUmask(() => scratch("umask"));
		await expectKeyRootAccepted(qa.agentDir);
	});

	test("#given umask 0002 #when the endpoint scratch builds its shard dir #then the host accepts the key root", async () => {
		const qa = await underGroupWritableUmask(() => endpointScratch("umask"));
		await expectKeyRootAccepted(qa.agentDir);
	});

	test("#given umask 0002 #when the daemon sandbox builds a canonical socket dir #then the host accepts the key root", async () => {
		const qa = await underGroupWritableUmask(() => sandbox("umask", { canonicalSocket: true }));
		await expectKeyRootAccepted(qa.agentDir);
	});

	test("#given umask 0002 #when the test setup quarantines the agent dir #then the host accepts it as a key root", async () => {
		const agentDir = await underGroupWritableUmask(() => resolveQuarantineAgentDir({}));
		if (agentDir === undefined) throw new Error("quarantine returned no agent dir");
		try {
			await expectKeyRootAccepted(agentDir);
		} finally {
			rmSync(dirname(agentDir), { recursive: true, force: true });
		}
	});

	test("#given a group-writable dir the fixture did not create #when the host checks it #then it is still refused", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-4541-"));
		try {
			const loose = join(root, "agent");
			await underGroupWritableUmask(() => mkdirSync(loose));
			await expect(checkRpcKeyDirectory(loose)).rejects.toMatchObject({ code: "unsafe_key_record" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
