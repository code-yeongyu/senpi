import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimEndpoint,
	closeShieldedEndpoint,
	endpointOwnerToken,
	readEndpointOwner,
} from "../../../src/modes/rpc/host-endpoint-owner.ts";
import { acquireHostEnsureLock, hostEnsureLockTarget } from "../../../src/modes/rpc/host-ensure-lock.ts";
import { acquireOwnershipSafeLock } from "../../../src/modes/rpc/ownership-safe-lock.ts";

// senpi#6871 review L1: engines before #6874 lock and fence an endpoint in `<tmpdir>/senpi-rpc-host-locks`, newer
// ones in `<tmpdir>/senpi-rpc-host-locks-<uid>`. During an upgrade both run against one socket, so a new engine also
// takes the legacy ensure lock and fence and keeps the owner token in both places whenever the legacy directory is this
// user's and no one else could write into it. Contract: an old and a new engine still exclude each other (senpi#4602).

const roots: string[] = [];
let saved: string | undefined;

beforeEach(() => {
	saved = process.env.TMPDIR;
});

afterEach(async () => {
	if (saved === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = saved;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A temp root holding the legacy lock directory an old engine of this user created (0755, its default). */
async function upgradedTmp(legacyMode = 0o755): Promise<{ tmp: string; legacy: string; socket: string }> {
	const tmp = await mkdtemp(join(tmpdir(), "e6871l-"));
	roots.push(tmp);
	process.env.TMPDIR = tmp;
	const legacy = join(tmp, "senpi-rpc-host-locks");
	await mkdir(legacy);
	await chmod(legacy, legacyMode);
	return { tmp, legacy, socket: join(tmp, "agent", "rpc", "rpc.sock") };
}

/** The path an old engine locks for `socket`: the same name, in the legacy directory. */
const legacyPath = (legacy: string, socket: string, suffix: string) =>
	join(legacy, `${basename(hostEnsureLockTarget(socket))}${suffix}`);

const once = { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } } as const;

describe.skipIf(process.platform === "win32")(
	"old and new engines exclude each other during an upgrade (#6871)",
	() => {
		it("a new ensure waits for an old engine holding the legacy ensure lock", async () => {
			const { legacy, socket } = await upgradedTmp();
			const old = await acquireOwnershipSafeLock(legacyPath(legacy, socket, ".lock"), once);
			try {
				await expect(acquireHostEnsureLock(socket, 200)).rejects.toThrow(/busy|locked/i);
			} finally {
				await old();
			}
			const release = await acquireHostEnsureLock(socket, 1_000);
			try {
				// And while the new engine holds it, an old engine is the one kept out.
				await expect(acquireOwnershipSafeLock(legacyPath(legacy, socket, ".lock"), once)).rejects.toThrow(
					/busy|locked/i,
				);
			} finally {
				await release();
			}
		});

		it("a new engine's fenced mutation holds the legacy fence too", async () => {
			const { legacy, socket } = await upgradedTmp();
			await claimEndpoint(socket, endpointOwnerToken(socket, "new-generation", 1));
			let oldFence: string | undefined;
			await closeShieldedEndpoint(socket, async () => {
				oldFence = await acquireOwnershipSafeLock(legacyPath(legacy, socket, ".fence.lock"), once).then(
					async (release) => {
						await release();
						return "acquired";
					},
					() => "busy",
				);
			});
			expect(oldFence).toBe("busy");
		});

		it("keeps the owner token where an old engine reads it, and reads an old engine's token", async () => {
			const { legacy, socket } = await upgradedTmp();
			await claimEndpoint(socket, endpointOwnerToken(socket, "new-generation", 1));
			const legacyToken = JSON.parse(await readFile(legacyPath(legacy, socket, ".owner.json"), "utf8"));
			expect(legacyToken.instanceId).toBe("new-generation");

			const other = await upgradedTmp();
			await mkdir(join(other.tmp, "agent", "rpc"), { recursive: true });
			const oldToken = endpointOwnerToken(other.socket, "old-generation", 0);
			await writeFile(legacyPath(other.legacy, other.socket, ".owner.json"), `${JSON.stringify(oldToken)}\n`);
			expect((await readEndpointOwner(other.socket))?.instanceId).toBe("old-generation");
		});

		// An old successor that adopted a new engine's endpoint wrote its token only where it reads it. The new predecessor
		// must see that successor as the owner, or its teardown would unlink the successor's entry (the senpi#4602 race).
		it("reads the higher generation when the two token copies disagree", async () => {
			const { legacy, socket } = await upgradedTmp();
			await claimEndpoint(socket, endpointOwnerToken(socket, "new-predecessor", 1));
			const successor = endpointOwnerToken(socket, "old-successor", 2);
			await writeFile(legacyPath(legacy, socket, ".owner.json"), `${JSON.stringify(successor)}\n`);
			expect((await readEndpointOwner(socket))?.instanceId).toBe("old-successor");
		});

		// Under umask 002 (user-private groups, the Debian/Ubuntu default) an old engine created the legacy directory 0775
		// with the user's own group: it must still be bridged, or the window stays open on exactly those machines.
		it("bridges a 0775 legacy directory whose group is the user's own primary group, and no other group", async () => {
			const { legacy, socket } = await upgradedTmp(0o775);
			const uid = process.getuid?.() ?? 0;
			await chown(legacy, uid, process.getgid?.() ?? 0);
			const old = await acquireOwnershipSafeLock(legacyPath(legacy, socket, ".lock"), once);
			try {
				await expect(acquireHostEnsureLock(socket, 200)).rejects.toThrow(/busy|locked/i);
			} finally {
				await old();
			}

			const otherGroup = process.getgroups?.().find((gid) => gid !== process.getgid?.());
			if (otherGroup === undefined) return;
			await chown(legacy, uid, otherGroup);
			const held = await acquireOwnershipSafeLock(legacyPath(legacy, socket, ".lock"), once);
			try {
				const release = await acquireHostEnsureLock(socket, 1_000);
				await release();
			} finally {
				await held();
			}
		});

		it("does not bridge a legacy directory others could write into", async () => {
			const { legacy, socket } = await upgradedTmp(0o777);
			const old = await acquireOwnershipSafeLock(legacyPath(legacy, socket, ".lock"), once);
			try {
				const release = await acquireHostEnsureLock(socket, 1_000);
				await release();
			} finally {
				await old();
			}
		});
	},
);
