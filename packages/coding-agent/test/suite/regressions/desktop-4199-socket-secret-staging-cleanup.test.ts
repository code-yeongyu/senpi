import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

const failClose = vi.hoisted(() => ({ armed: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (!failClose.armed || !String(args[0]).includes(".stage-")) return handle;
			failClose.armed = false;
			const close = handle.close.bind(handle);
			handle.close = async () => {
				await close();
				throw new Error("injected close failure");
			};
			return handle;
		},
	};
});

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.3 step 7, review LOW on
// senpi#4369). Contract: whatever fails while the staging file is being finished, that attempt's staging file is removed
// and the failure reaches the caller; nothing is published from a staging file whose close failed.
describe.skipIf(process.platform === "win32")("staging cleanup when closing the staging file fails", () => {
	const roots: string[] = [];

	afterEach(async () => {
		failClose.armed = false;
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	it("removes the staging file and reports the close failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-close-"));
		roots.push(root);
		failClose.armed = true;
		await expect(createSocketSecret(join(root, "rpc.sock.secret"))).rejects.toThrow("injected close failure");
		expect(await readdir(root)).toEqual([]);
	});
});
