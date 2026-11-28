import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostEnsureLockTarget } from "../../src/modes/rpc/host-ensure-lock.ts";

// senpi#6738: the ensure-lock root sits in the OS temp directory, which every user of the machine shares. A
// second OS user therefore hit the first user's directory (EACCES) for the same socket. The root is per user.
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("the host ensure lock root (senpi#6738)", () => {
	it("names a per-user lock root under the temp directory", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-6738-"));
		dirs.push(root);
		vi.stubEnv("TMPDIR", root);
		const uid = process.getuid?.() ?? 0;
		const target = hostEnsureLockTarget("/tmp/one.sock", uid);
		expect(target.startsWith(join(root, `senpi-rpc-host-locks-${uid}`))).toBe(true);
	});

	it("gives two OS users different roots for the same socket", () => {
		expect(hostEnsureLockTarget("/tmp/one.sock", 1000)).not.toBe(hostEnsureLockTarget("/tmp/one.sock", 1001));
	});
});
