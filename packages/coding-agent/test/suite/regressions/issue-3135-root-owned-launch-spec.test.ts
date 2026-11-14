/**
 * senpi#3135: a launch spec owned by root is trusted like one owned by the current uid, so a
 * system-wide install (deb, AppImage, rpm, Homebrew) can start the shared host. A file anyone can
 * rewrite, or one owned by another non-root uid, is still refused, and win32 still has no owner proof.
 *
 * The root-owned cases use real system files instead of faked ownership: /etc/hosts is root-owned
 * and not group/world writable on macOS and Linux, and /dev/null is root-owned and world writable.
 * Neither is a launch spec, so a file that passes the owner proof ends at the parser.
 */
import { statSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostLaunchSpecError, loadHostLaunchSpec } from "../../../src/modes/rpc/host-launch-spec.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function rootOwned(path: string): { groupOrWorldWritable: boolean } | undefined {
	const stats = statSync(path, { throwIfNoEntry: false });
	return stats?.uid === 0 ? { groupOrWorldWritable: (stats.mode & 0o022) !== 0 } : undefined;
}

const hosts = rootOwned("/etc/hosts");
const devNull = rootOwned("/dev/null");

describe.skipIf(process.platform === "win32")("launch spec owner proof", () => {
	it.runIf(hosts?.groupOrWorldWritable === false)("trusts a root-owned file nobody else can write", async () => {
		expect(await refusal(loadHostLaunchSpec("/etc/hosts"))).toBe("launch_spec_invalid");
	});

	it.runIf(devNull?.groupOrWorldWritable === true)("still refuses a root-owned file anyone can write", async () => {
		expect(await refusal(loadHostLaunchSpec("/dev/null"))).toBe("launch_spec_insecure");
	});

	it.skipIf(process.getuid?.() === 0)("still refuses a spec owned by another non-root uid", async () => {
		const path = await ownSpec();
		vi.spyOn(process, "getuid").mockReturnValue(statSync(path).uid + 1);

		expect(await refusal(loadHostLaunchSpec(path))).toBe("launch_spec_insecure");
	});

	it("keeps trusting a spec owned by the current uid", async () => {
		await expect(loadHostLaunchSpec(await ownSpec())).resolves.toMatchObject({
			hostArgs: ["--session-runtime", "in-process"],
		});
	});
});

it("still applies no owner proof on win32", async () => {
	const path = await ownSpec();
	await chmod(path, 0o666);

	await expect(loadHostLaunchSpec(path, "win32")).resolves.toMatchObject({
		hostArgs: ["--session-runtime", "in-process"],
	});
});

async function ownSpec(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hs3135-"));
	roots.push(root);
	const path = join(root, "launch.json");
	const document = { spec_version: 1, core: { session_runtime: "in-process", multi_session: true, extensions: [] } };
	await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
	return path;
}

async function refusal(load: Promise<unknown>): Promise<string> {
	const outcome = await load.then(
		() => undefined,
		(error: unknown) => error,
	);
	if (outcome instanceof HostLaunchSpecError) return outcome.reason;
	throw new Error(`expected a launch spec refusal, got ${String(outcome)}`);
}
