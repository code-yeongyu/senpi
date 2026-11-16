import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../../src/config.ts";
import { type BundledBunHost, bundledBunDir, bundledBunShimRoots } from "../../../src/utils/bundled-bun.ts";

// senpi#6871: the bundled bun shims fall back to a temp root when the agent directory cannot hold them. That root was
// `<tmpdir>/senpi-bundled-bun`, one directory for every user of a Linux machine: once another user had created it, this
// user's shims could not be written there. The temp root is now this user's own (`<tmpdir>/senpi-bundled-bun-<uid>`,
// 0700), and a symlink or foreign directory at its name is never used. Security contract: the directory a PATH entry for agent shells points at is private to its user.

const uid = process.getuid?.();
const roots: string[] = [];
let saved: string | undefined;
let agentShimRoot: string;

beforeEach(async () => {
	saved = process.env.TMPDIR;
	// The agent directory cannot hold the shims (a file sits at their directory's name), so the temp root is used.
	agentShimRoot = join(getAgentDir(), "bundled-bun");
	await mkdir(dirname(agentShimRoot), { recursive: true });
	await rm(agentShimRoot, { recursive: true, force: true });
	await writeFile(agentShimRoot, "not a directory");
});

afterEach(async () => {
	if (saved === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = saved;
	await rm(agentShimRoot, { force: true });
	for (const root of roots.splice(0)) {
		await chmod(root, 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

async function sharedTmp(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "e6871b-"));
	roots.push(root);
	process.env.TMPDIR = root;
	return root;
}

/** A compiled executable's facts; a fresh execPath per case keeps the per-process memo out of the way. */
function compiledHost(tmp: string): BundledBunHost {
	return { main: "/$bunfs/root/omo", execPath: join(tmp, "omo"), platform: "linux", ...bundledBunShimRoots() };
}

describe.skipIf(process.platform === "win32")(
	"bundled bun shims live in a directory private to the user (#6871)",
	() => {
		it("a second user gets shims although another user created the old shared temp root first", async () => {
			const tmp = await sharedTmp();
			const shared = join(tmp, "senpi-bundled-bun");
			await mkdir(shared, { mode: 0o755 });
			await chmod(shared, 0o555);

			const dir = bundledBunDir(compiledHost(tmp));

			expect(dir).toBeDefined();
			expect(dirname(dir ?? "")).toBe(join(tmp, `senpi-bundled-bun-${uid}`));
			const root = await stat(join(tmp, `senpi-bundled-bun-${uid}`));
			expect({ mode: root.mode & 0o777, uid: root.uid }).toEqual({ mode: 0o700, uid });
			expect(await readdir(shared)).toEqual([]);
		});

		// Review #2 M1: only the temp fallback sits under a directory other users share. The agent-dir root is the user's
		// own, and older engines created it with the umask's mode (0775 under umask 002, 0755 under 022): it must keep
		// working exactly as before, unmodified, rather than being refused or chmodded and the PATH entry moved to /tmp.
		it("uses an existing agent-dir root as it is, whatever mode an older engine created it with", async () => {
			const tmp = await sharedTmp();
			await rm(agentShimRoot, { force: true });
			await mkdir(agentShimRoot);
			for (const [index, mode] of [0o775, 0o755].entries()) {
				await chmod(agentShimRoot, mode);
				const host = { ...compiledHost(tmp), execPath: join(tmp, `omo-${index}`) };

				const dir = bundledBunDir(host);

				expect(dirname(dir ?? "")).toBe(agentShimRoot);
				expect((await stat(agentShimRoot)).mode & 0o777).toBe(mode);
			}
			await rm(agentShimRoot, { recursive: true, force: true });
		});

		it("never materializes shims through a symlink planted at the per-user temp root", async () => {
			const tmp = await sharedTmp();
			const elsewhere = await mkdtemp(join(tmp, "planted-"));
			await symlink(elsewhere, join(tmp, `senpi-bundled-bun-${uid}`));

			expect(bundledBunDir(compiledHost(tmp))).toBeUndefined();

			expect((await lstat(join(tmp, `senpi-bundled-bun-${uid}`))).isSymbolicLink()).toBe(true);
			expect(await readdir(elsewhere)).toEqual([]);
		});
	},
);
