import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listen as listenProxy, prepareSocketPath } from "../../../src/modes/rpc/host-lifecycle-proxy.ts";
import { listen as listenOwned } from "../../../src/modes/rpc/host-socket-bind.ts";
import {
	classifyEndpointOwnership,
	MAX_SOCKET_PATH_BYTES,
	statSocketIdentity,
	unlinkOwnedSocket,
} from "../../../src/modes/rpc/socket-ownership.ts";

// senpi#5319: on macOS bind(2) follows a dangling symlink at the endpoint and creates the socket at the link's
// target. An entry planted after prepareSocketPath (#5314) freed the path must be refused, never bound through.

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		if (server.listening) await new Promise((resolve) => server.close(resolve));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function endpoint(): Promise<{ root: string; socket: string }> {
	const root = await mkdtemp(join(tmpdir(), "e5319-"));
	roots.push(root);
	return { root, socket: join(root, "rpc.sock") };
}

/** An endpoint whose full path is exactly `total` bytes, named `name`, in a fresh 0700 directory. */
async function endpointOfLength(total: number, name: string): Promise<{ dir: string; socket: string }> {
	const root = await mkdtemp(join(tmpdir(), "e5319-"));
	roots.push(root);
	const pad = total - Buffer.byteLength(root) - Buffer.byteLength(name) - 2;
	if (pad < 1) throw new Error(`temp root ${root} is too long to build a ${total}-byte endpoint`);
	const dir = join(root, "d".repeat(pad));
	await mkdir(dir, { mode: 0o700 });
	const socket = join(dir, name);
	expect(Buffer.byteLength(socket)).toBe(total);
	return { dir, socket };
}

function close(target: Server): Promise<void> {
	return new Promise((resolve) => target.close(() => resolve()));
}

/** The path libuv bound, and will unlink when the server closes. */
function boundPath(target: Server): string {
	const address = target.address();
	if (typeof address !== "string") throw new Error("not a pipe server");
	return address;
}

function server(): Server {
	const created = createServer((client) => client.end("ok"));
	servers.push(created);
	return created;
}

function accepts(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const client = createConnection(path);
		client.once("data", () => {
			client.destroy();
			resolve(true);
		});
		client.once("error", () => resolve(false));
	});
}

const binders = [
	["host-lifecycle-proxy listen", (target: Server, path: string) => listenProxy(target, path)],
	["host-socket-bind listen", (target: Server, path: string) => listenOwned(target, path)],
] as const;

describe.skipIf(process.platform === "win32")(
	"the host never binds through an entry planted at the endpoint (#5319)",
	() => {
		for (const [name, bind] of binders) {
			it(`${name}: refuses a dangling symlink planted after prepareSocketPath and creates nothing at its target`, async () => {
				const { root, socket } = await endpoint();
				const target = join(root, "elsewhere.sock");
				await prepareSocketPath(socket);
				await symlink(target, socket);
				const host = server();

				await expect(bind(host, socket)).rejects.toThrow("address already in use");

				await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
				expect((await lstat(socket)).isSymbolicLink()).toBe(true);
				expect(await readlink(socket)).toBe(target);
				expect(host.listening).toBe(false);
				expect((await readdir(root)).sort()).toEqual(["rpc.sock"]);
			});

			it(`${name}: refuses a live socket that took the endpoint after prepareSocketPath and leaves it serving`, async () => {
				const { root, socket } = await endpoint();
				await prepareSocketPath(socket);
				const other = server();
				await new Promise<void>((resolve) => other.listen(socket, resolve));
				const before = await lstat(socket, { bigint: true });
				const host = server();

				await expect(bind(host, socket)).rejects.toThrow("address already in use");

				const after = await lstat(socket, { bigint: true });
				expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
				expect(await accepts(socket)).toBe(true);
				expect(host.listening).toBe(false);
				expect((await readdir(root)).sort()).toEqual(["rpc.sock"]);
			});

			it(`${name}: publishes its own 0600 socket at the endpoint and leaves no bind scratch behind`, async () => {
				const { root, socket } = await endpoint();
				await prepareSocketPath(socket);
				const host = server();

				await bind(host, socket);

				const entry = await lstat(socket);
				expect(entry.isSocket()).toBe(true);
				expect(entry.mode & 0o777).toBe(0o600);
				expect(await accepts(socket)).toBe(true);
				await close(host);
				expect((await readdir(root)).sort()).toEqual(["rpc.sock"]);
			});

			// Review of #5404: libuv unlinks the path it BOUND when the server closes. Once the scratch directories
			// were removed right after listen, anyone able to re-create one of their names (a sibling of the endpoint,
			// or an alias under a shared /tmp) could point it at another directory and have the host delete `s` there.
			for (const total of [undefined, MAX_SOCKET_PATH_BYTES]) {
				it(`${name}: a ${total ?? "short"}-byte endpoint's bind path cannot be re-pointed before close`, async () => {
					const socket =
						total === undefined ? (await endpoint()).socket : (await endpointOfLength(total, "rpc.sock")).socket;
					const victim = (await endpoint()).root;
					await writeFile(join(victim, "s"), "keep");
					await prepareSocketPath(socket);
					const host = server();
					await bind(host, socket);
					const bound = boundPath(host);

					// The attacker: every scratch directory on the bound path that no longer exists is re-created as a
					// link to the victim. One that still exists is ours (0700) and cannot be replaced by another user.
					const scratch = dirname(bound).startsWith(socket) ? dirname(bound) : dirname(dirname(bound));
					const planted = await mkdir(scratch, { mode: 0o700 }).then(
						() => true,
						(cause: NodeJS.ErrnoException) => {
							if (cause.code === "EEXIST") return false;
							throw cause;
						},
					);
					if (planted) {
						await rm(scratch, { recursive: true });
						if (scratch === dirname(bound)) await symlink(victim, scratch);
						else {
							await mkdir(scratch, { mode: 0o700 });
							await symlink(victim, dirname(bound));
						}
					}
					await close(host);

					await expect(lstat(join(victim, "s"))).resolves.toBeDefined();
					await expect(lstat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
					await expect(lstat(dirname(bound))).rejects.toMatchObject({ code: "ENOENT" });
					if (planted) await rm(scratch, { recursive: true, force: true });
				});
			}
		}

		// Review of #5404: a bind directory beside the endpoint pushed the bind path past the limit for endpoints
		// prepareSocketPath accepts. Every endpoint up to MAX_SOCKET_PATH_BYTES must still bind and publish.
		for (const total of [99, MAX_SOCKET_PATH_BYTES]) {
			for (const name of ["s", "rpc.sock"]) {
				for (const [binder, bind] of binders) {
					it(`${binder}: binds a ${total}-byte endpoint named ${name} and leaves no bind scratch behind`, async () => {
						const { dir, socket } = await endpointOfLength(total, name);
						await prepareSocketPath(socket);
						const host = server();

						await bind(host, socket);

						const entry = await lstat(socket);
						expect(entry.isSocket()).toBe(true);
						expect(entry.mode & 0o777).toBe(0o600);
						expect(await accepts(socket)).toBe(true);
						const bound = boundPath(host);
						await close(host);
						expect(await readdir(dir)).toEqual([name]);
						// An alias outside the endpoint's directory is gone too.
						await expect(lstat(dirname(bound))).rejects.toMatchObject({ code: "ENOENT" });
						if (!dirname(bound).startsWith(socket)) {
							await expect(lstat(dirname(dirname(bound)))).rejects.toMatchObject({ code: "ENOENT" });
						}
					});
				}
			}
		}

		it("statSocketIdentity reads a symlink at a socket path as its own entry, never as the socket it names", async () => {
			const { root, socket } = await endpoint();
			const target = join(root, "real.sock");
			const real = server();
			await new Promise<void>((resolve) => real.listen(target, resolve));
			const targetIdentity = await statSocketIdentity(target);
			await symlink(target, socket);
			const link = await lstat(socket);
			const notes: string[] = [];

			expect(await statSocketIdentity(socket)).toEqual({ dev: link.dev, ino: link.ino });
			expect(await classifyEndpointOwnership(socket, targetIdentity)).toBe("replaced");
			await unlinkOwnedSocket(socket, targetIdentity, (message) => notes.push(message));

			expect(notes).toEqual([`socket path ${socket} now owned by another host; leaving it`]);
			expect(await readlink(socket)).toBe(target);
			expect(await accepts(target)).toBe(true);
		});

		it("host-socket-bind listen reports the identity of the entry it published", async () => {
			const { socket } = await endpoint();
			await prepareSocketPath(socket);

			const identity = await listenOwned(server(), socket);

			const entry = await lstat(socket);
			expect(identity).toEqual({ dev: entry.dev, ino: entry.ino });
		});
	},
);
