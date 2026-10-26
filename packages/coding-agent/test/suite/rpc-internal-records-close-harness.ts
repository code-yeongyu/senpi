import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { acceptInternalConnection, connectInternalConnection } from "../../src/modes/rpc/internal-channel.ts";

// senpi#3816 review: the host ends a large write while the supervisor-side reader is held back by a slow
// public client. Every complete record already sent must still reach the reader.
const total = Number(process.argv[2]);
const key = Buffer.alloc(32, 7);
const root = mkdtempSync("/tmp/rpc-hop-close-");
const path = join(root, "host.sock");
const payload = Buffer.alloc(total, 0x61);
payload[total - 1] = 0x0a;
const server = createServer((socket) => {
	void acceptInternalConnection(socket, key).then((stream) => stream.end(payload));
});
await new Promise<void>((resolve) => server.listen(path, resolve));
let received = 0;
let error: string | undefined;
try {
	const stream = await connectInternalConnection(createConnection(path), key);
	for await (const chunk of stream) {
		received += (chunk as Buffer).length;
		// A slow consumer: each chunk waits on its own downstream write before the next is read.
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
} catch (cause) {
	error = cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? cause.message) : String(cause);
}
server.close();
rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ received, error })}\n`);
