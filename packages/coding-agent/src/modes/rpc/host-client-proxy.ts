import { createConnection, createServer, type Server, type Socket } from "node:net";
import { authenticateSocket, resolveSocketTransportAddress, sendSocketHandshake } from "./socket-transport.ts";

interface HostProxyEndpoints {
	readonly publicSecret: Uint8Array | undefined;
	readonly internalSocket: string;
	readonly internalSecret: Uint8Array | undefined;
}

interface HostProxyActivity {
	readonly clients: Set<Socket>;
	readonly isShuttingDown: () => boolean;
	readonly onActivity: () => void;
}

/** Authenticated public connections proxied to the private RPC host. */
export function createHostClientProxy(endpoints: HostProxyEndpoints, activity: HostProxyActivity): Server {
	return createServer((client) => {
		const accept = (): void => {
			if (activity.isShuttingDown()) {
				client.destroy();
				return;
			}
			const internal = createConnection(
				resolveSocketTransportAddress(endpoints.internalSocket, process.platform, endpoints.internalSecret),
			);
			if (endpoints.internalSecret) sendSocketHandshake(internal, endpoints.internalSecret);
			activity.clients.add(client);
			// A readiness probe can connect and disconnect entirely between ticks.
			// Record both edges so the idle window measures continuous inactivity.
			activity.onActivity();
			const detach = (): void => {
				if (activity.clients.delete(client)) activity.onActivity();
				internal.destroy();
				client.destroy();
			};
			client.pipe(internal);
			internal.pipe(client);
			client.once("close", detach);
			client.once("error", detach);
			internal.once("close", detach);
			internal.once("error", detach);
		};
		if (endpoints.publicSecret) authenticateSocket(client, endpoints.publicSecret, accept);
		else accept();
	});
}
