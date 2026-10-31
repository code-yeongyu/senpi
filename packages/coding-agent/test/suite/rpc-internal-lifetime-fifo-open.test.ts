import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { armLifetimeBinding } from "../../src/modes/rpc/host-lifetime-binding.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hopDir(): string {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? "/Users/Shared", "fifo-open-"));
	chmodSync(dir, 0o700);
	roots.push(dir);
	return dir;
}

// senpi#3816 review (L5): the host opens the lifetime FIFO with O_NOFOLLOW and accepts only a FIFO owned by this user
// with mode 0600. Anything else at that path is refused: a regular file there would read EOF and stop the host.
describe("lifetime FIFO open", () => {
	it.each(["regular file", "symlink to a FIFO", "FIFO with mode 0644"] as const)("refuses a %s", (kind) => {
		const dir = hopDir();
		const path = join(dir, "lifetime.fifo");
		if (kind === "regular file") writeFileSync(path, "", { mode: 0o600 });
		else if (kind === "symlink to a FIFO") {
			execFileSync("mkfifo", ["-m", "600", join(dir, "real.fifo")]);
			symlinkSync(join(dir, "real.fifo"), path);
		} else execFileSync("mkfifo", ["-m", "644", path]);
		const gone = vi.fn();
		const stop = armLifetimeBinding({ lifetimeFifo: path }, gone, vi.fn(), "linux");
		stop?.();
		expect(stop).toBeUndefined();
		expect(gone).not.toHaveBeenCalled();
	});

	it("accepts this user's 0600 FIFO", () => {
		const path = join(hopDir(), "lifetime.fifo");
		execFileSync("mkfifo", ["-m", "600", path]);
		const stop = armLifetimeBinding({ lifetimeFifo: path }, vi.fn(), vi.fn(), "linux");
		try {
			expect(stop).toBeTypeOf("function");
		} finally {
			stop?.();
		}
	});
});
