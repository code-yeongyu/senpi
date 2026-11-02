import { createConnection, type Socket } from "node:net";
import { connectAuthenticatedRpcSocket, type RpcKeyOptions } from "./rpc-auth-client.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";
import { socketNeedsHandshake } from "./tui-socket.ts";

/** Public POSIX authentication and the unchanged TUI/Windows raw-secret connection path. */
export async function connectRpcClientSocket(path: string, options: RpcKeyOptions): Promise<Socket> {
	if (!socketNeedsHandshake(path)) return (await connectAuthenticatedRpcSocket(path, undefined, options)).socket;
	const secret = await readSocketSecret(socketSecretPath(path));
	const socket = createConnection(resolveSocketTransportAddress(path, process.platform, secret));
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		const onConnect = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
	sendSocketHandshake(socket, secret);
	return socket;
}
