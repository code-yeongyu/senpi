import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSocketSecret } from "../../../src/modes/rpc/socket-transport.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (design 4.3 step 1).
// Security contract: only a regular file at the secret path is a credential this process may reuse or
// repair. A terminal symlink or another entry type is refused, never followed and never written through.
describe.skipIf(process.platform === "win32")("ensureSocketSecret and the secret entry type", () => {
	const roots: string[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	async function scratch(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "rpc4199-entry-"));
		roots.push(root);
		return root;
	}

	it.each([
		["valid", 32],
		["wrong-sized", 8],
	])("refuses a %s secret behind a symbolic link and leaves the link target unchanged", async (_label, size) => {
		const root = await scratch();
		const target = join(root, "elsewhere");
		const original = Buffer.alloc(size, 5);
		await writeFile(target, original);
		const secretPath = join(root, "rpc.sock.secret");
		await symlink(target, secretPath);

		await expect(ensureSocketSecret(secretPath)).rejects.toThrow(/not a regular file/);
		expect(await readFile(target)).toEqual(original);
	});

	it("refuses a directory at the secret path", async () => {
		const root = await scratch();
		const secretPath = join(root, "rpc.sock.secret");
		await mkdir(secretPath);

		await expect(ensureSocketSecret(secretPath)).rejects.toThrow(/not a regular file/);
	});
});
