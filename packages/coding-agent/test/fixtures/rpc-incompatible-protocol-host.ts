import { createServer } from "node:net";
import {
	authenticateSocket,
	readSocketSecret,
	resolveSocketTransportAddress,
	socketSecretPath,
} from "../../src/modes/rpc/socket-transport.ts";

const path = process.argv.at(-1);
if (!path) throw new Error("socket path required");
const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(path)) : undefined;
const server = createServer((socket) => {
	const reply = (): void => {
		socket.on("data", () => {
			socket.end(
				`${JSON.stringify({
					id: "ensure-host-probe",
					success: true,
					data: { serverVersion: "0.0.0-wrong", capabilities: [] },
				})}\n`,
			);
		});
	};
	if (secret) authenticateSocket(socket, secret, reply);
	else reply();
});
server.listen(resolveSocketTransportAddress(path, process.platform, secret));
