// senpi#7388: a public proxy whose hop to the host fails, driven by two clients in a row. Prints each reply as one
// JSON line on stdout and exits; the supervisor's own diagnostics go to the real fd 2, which the test reads.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAdmission } from "../../src/modes/rpc/host-admission.ts";
import { ClientOccupancy } from "../../src/modes/rpc/host-client-occupancy.ts";
import { createPublicProxy, listen } from "../../src/modes/rpc/host-lifecycle-proxy.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

const keyed = process.argv[2] === "keyed";
const dir = await mkdtemp(join(tmpdir(), "hop-fail-"));
const internalPath = join(dir, "i.sock");
const publicPath = join(dir, "p.sock");
// With a key, the host accepts and then drops the hop before its handshake; without one, nothing listens.
const internal = keyed ? createServer((peer) => peer.destroy()) : undefined;
if (internal) await listen(internal, internalPath);
const clients = new ClientOccupancy(() => {});
const server = createPublicProxy({
	internalSocket: internalPath,
	...(keyed ? { internalKey: Buffer.alloc(32, 7) } : {}),
	clients,
	admission: new HostAdmission({ protocolVersion: 1, serverVersion: "fixture", capabilities: [], instanceId: "hop" }),
	onDetach: () => {},
});
await listen(server, publicPath);

for (const id of ["open-1", "open-2"]) {
	const client = createConnection(publicPath);
	// A reset before any reply settles as `{ closed: true }`.
	const reply = new Promise<unknown>((resolve) => {
		attachJsonlLineReader(client, (line) => resolve(JSON.parse(line)));
		client.once("close", () => resolve({ closed: true }));
		client.once("error", () => resolve({ closed: true }));
	});
	await once(client, "connect");
	client.write(`${JSON.stringify({ id, type: "open_session", cwd: dir })}\n`);
	process.stdout.write(`${JSON.stringify(await reply)}\n`);
	client.destroy();
}
clients.destroyAll();
await new Promise<void>((resolve) => server.close(() => resolve()));
if (internal) await new Promise<void>((resolve) => internal.close(() => resolve()));
await rm(dir, { recursive: true, force: true });
process.exit(0);
