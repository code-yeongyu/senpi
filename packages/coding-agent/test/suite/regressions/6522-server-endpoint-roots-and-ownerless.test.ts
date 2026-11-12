import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createServerEndpoint,
	reapOrphanedServerEndpoints,
	SHORT_SERVER_ENDPOINT_PREFIX,
} from "../../../src/experimental/socket-path.ts";

// senpi#6522: an endpoint directory a server never finished claiming (no usable owner record) is removed once no
// starting server could still be writing one, and the per-user runtime directory is preferred over the shared temp
// roots when it is guarded.
const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(mode: number): string {
	const root = mkdtempSync("/tmp/pes-roots-");
	chmodSync(root, mode);
	roots.push(root);
	return root;
}

function ownerlessDir(root: string, name: string, ageMs: number): string {
	const directory = join(root, `${SHORT_SERVER_ENDPOINT_PREFIX}${name}`);
	mkdirSync(directory, { mode: 0o700 });
	writeFileSync(join(directory, "server.sock"), "");
	const at = new Date(Date.now() - ageMs);
	utimesSync(directory, at, at);
	return directory;
}

it("removes an ownerless endpoint directory after five minutes and keeps a fresh one", async () => {
	const root = tempRoot(0o700);
	const aged = ownerlessDir(root, "a6ed0000", 600_000);
	const fresh = ownerlessDir(root, "fre5h000", 1_000);

	await reapOrphanedServerEndpoints([root]);

	expect({ aged: existsSync(aged), fresh: existsSync(fresh) }).toEqual({ aged: false, fresh: true });
});

it("places the endpoint in the runtime directory when the temp directory is not guarded", async () => {
	const unguarded = tempRoot(0o777);
	const runtime = tempRoot(0o700);
	vi.stubEnv("TMPDIR", unguarded);
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	const deep = join("/tmp", "d".repeat(70), "server-00000000-0000-4000-8000-000000000001-0123456789ab.sock");

	const endpoint = await createServerEndpoint(deep);

	expect(endpoint.path.startsWith(`${runtime}/`)).toBe(true);
	await endpoint.release();
});
