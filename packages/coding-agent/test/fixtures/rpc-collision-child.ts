import { createServer } from "node:net";
import {
	authenticateSocket,
	readSocketSecret,
	resolveSocketTransportAddress,
	SOCKET_SECRET_FILE_ENV,
} from "../../src/modes/rpc/socket-transport.ts";

const listen = process.argv.at(-1);
if (!listen) throw new Error("listen address required");
const path = listen.startsWith("unix://") ? listen.slice("unix://".length) : listen;
const secretPath = process.env[SOCKET_SECRET_FILE_ENV];
const secret = process.platform === "win32" && secretPath ? await readSocketSecret(secretPath) : undefined;
const server = createServer((socket) => {
	if (secret) authenticateSocket(socket, secret, () => socket.resume());
	else socket.resume();
});
server.listen(resolveSocketTransportAddress(path, process.platform, secret));
