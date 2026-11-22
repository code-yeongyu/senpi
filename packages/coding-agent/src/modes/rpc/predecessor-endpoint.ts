import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { writeJsonAtomic } from "./host-state-json.ts";
import { listen } from "./host-socket-bind.ts";
import { PublicRpcConnection } from "./rpc-public-auth.ts";
import { RpcPublicEndpoint } from "./rpc-public-key.ts";
import { unlinkOwnedSocket } from "./socket-ownership.ts";

/** Not the supervisor's sealed child hop: a generation-stable address with ordinary mutual endpoint authentication. */
export async function listenForSuccessor(
	agentDir: string,
	childSocket: string,
	generationDir: string,
	accept: (stream: Duplex) => void,
): Promise<() => Promise<void>> {
	const path = join(dirname(childSocket), "route");
	const endpoint = new RpcPublicEndpoint(agentDir, path);
	const server = createServer((socket) => accept(new PublicRpcConnection(socket, endpoint, true).stream));
	const record = join(generationDir, "route.json");
	const identity = await listen(server, path);
	const unpublish = () =>
		unlinkOwnedSocket(path, identity, (message) => process.stderr.write(`senpi rpc: ${message}\n`));
	try {
		await endpoint.publish();
		await writeJsonAtomic(record, { socket: path, launchId: endpoint.launchId });
	} catch (cause) {
		server.close();
		await endpoint.dispose();
		await unpublish();
		throw cause;
	}
	return async () => {
		server.close();
		await endpoint.dispose();
		await rm(record, { force: true });
		await unpublish();
	};
}
