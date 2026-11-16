import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHookOutputSafety } from "../../../src/core/extensions/builtin/hooks/output-bounds.ts";

// senpi#6871: hook output over the limit is spilled, redacted, to a file. Without a configured spill directory that was
// `<tmpdir>/senpi-hook-output`, one directory for every user of a Linux machine: once another user had created it this
// user's spill failed with EACCES, and the spill files sat in a directory other users could list. The default spill
// directory is now this user's own (`<tmpdir>/senpi-hook-output-<uid>`, 0700) and each spill file is 0600. Security contract: hook output stays private.

const uid = process.getuid?.();
const roots: string[] = [];
let saved: string | undefined;

beforeEach(() => {
	saved = process.env.TMPDIR;
});

afterEach(async () => {
	if (saved === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = saved;
	for (const root of roots.splice(0)) {
		await chmod(root, 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

async function sharedTmp(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "e6871h-"));
	roots.push(root);
	process.env.TMPDIR = root;
	return root;
}

/** Output one byte over the limit, so it is spilled to the default directory. */
const spill = () => applyHookOutputSafety("stdout", "x".repeat(65), { maxStdoutBytes: 64 });

describe.skipIf(process.platform === "win32")(
	"hook output spills go to a directory private to the user (#6871)",
	() => {
		it("a second user's hook spills although another user created the old shared directory first", async () => {
			const tmp = await sharedTmp();
			const shared = join(tmp, "senpi-hook-output");
			await mkdir(shared, { mode: 0o755 });
			await chmod(shared, 0o555);

			const { safety } = spill();

			expect(dirname(safety.spillPath ?? "")).toBe(join(tmp, `senpi-hook-output-${uid}`));
			const dir = await stat(join(tmp, `senpi-hook-output-${uid}`));
			expect({ mode: dir.mode & 0o777, uid: dir.uid }).toEqual({ mode: 0o700, uid });
			expect((await stat(safety.spillPath ?? "")).mode & 0o777).toBe(0o600);
			expect(await readdir(shared)).toEqual([]);
		});

		// Review #2 L1: another user can squat the predictable per-uid name (a sticky /tmp keeps the victim from removing it).
		// A spill is a one-off file, so it falls back to a fresh private directory instead of failing every oversized hook.
		it("falls back to a fresh private directory when the per-user name is squatted, writing nothing through it", async () => {
			const tmp = await sharedTmp();
			const elsewhere = await mkdtemp(join(tmp, "planted-"));
			await symlink(elsewhere, join(tmp, `senpi-hook-output-${uid}`));

			const { safety } = spill();

			const dir = dirname(safety.spillPath ?? "");
			expect(dir.startsWith(join(tmp, `senpi-hook-output-${uid}-`))).toBe(true);
			const entry = await lstat(dir);
			expect({ dir: entry.isDirectory(), mode: entry.mode & 0o777, uid: entry.uid }).toEqual({
				dir: true,
				mode: 0o700,
				uid,
			});
			expect((await lstat(join(tmp, `senpi-hook-output-${uid}`))).isSymbolicLink()).toBe(true);
			expect(await readdir(elsewhere)).toEqual([]);
		});
	},
);
