import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSocketSecret, ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.3, tests 1 and 2 and
// the "Creation collision" row). Security contract: the first complete 32-byte secret published at a path wins; a later
// or concurrent creator returns that winner and never replaces, truncates or rewrites it. POSIX only: Windows keeps its
// in-place writer until the native bridge (senpi#4310/#4312) is wired.
describe.skipIf(process.platform === "win32")("first publisher wins the socket secret", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function scratch(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-publish-"));
		roots.push(root);
		return root;
	}

	it("a second creator returns the published winner and leaves its bytes unchanged", async () => {
		const secretPath = join(await scratch(), "rpc.sock.secret");
		const winner = await createSocketSecret(secretPath);
		const loser = await createSocketSecret(secretPath);
		expect(loser).toEqual(winner);
		expect(await readFile(secretPath)).toEqual(winner);
	});

	it("concurrent creators all return the one persisted secret", async () => {
		const root = await scratch();
		const secretPath = join(root, "rpc.sock.secret");
		const results = await Promise.all(Array.from({ length: 8 }, () => createSocketSecret(secretPath)));
		const persisted = await readFile(secretPath);
		expect(persisted).toHaveLength(32);
		for (const result of results) expect(result).toEqual(persisted);
		expect(await readdir(root)).toEqual(["rpc.sock.secret"]);
	});

	it("publishes an owner-only file in a newly created owner-only directory and leaves no staging file", async () => {
		const dir = join(await scratch(), "fresh");
		const secretPath = join(dir, "rpc.sock.secret");
		await createSocketSecret(secretPath);
		expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		expect(await readdir(dir)).toEqual(["rpc.sock.secret"]);
	});

	it("a creator that finds an invalid winner refuses instead of replacing it", async () => {
		const root = await scratch();
		const secretPath = join(root, "rpc.sock.secret");
		const invalid = Buffer.alloc(8, 3);
		await writeFile(secretPath, invalid, { mode: 0o600 });
		await expect(createSocketSecret(secretPath)).rejects.toThrow(/invalid/);
		expect(await readFile(secretPath)).toEqual(invalid);
		expect(await readdir(root)).toEqual(["rpc.sock.secret"]);
	});

	it("ensure still repairs a wrong-sized secret when no creator is racing it", async () => {
		const root = await scratch();
		await mkdir(root, { recursive: true });
		const secretPath = join(root, "rpc.sock.secret");
		await writeFile(secretPath, Buffer.alloc(8, 3), { mode: 0o600 });
		const repaired = await ensureSocketSecret(secretPath);
		expect(repaired).toHaveLength(32);
		expect(await readFile(secretPath)).toEqual(repaired);
	});
});
