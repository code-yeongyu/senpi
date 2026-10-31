/**
 * A supervised fixture host admits each internal connection the way the real host does (senpi#3795): sealed with the
 * key its supervisor handed it on stdin, or raw when there is none (Windows, or a host started without a supervisor).
 * Importing this module runs the stdin bootstrap, so a fixture imports it before anything else touches stdin.
 */
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { getInternalHostBootstrap } from "../../src/modes/rpc/internal-bootstrap.ts";
import { acceptInternalConnection } from "../../src/modes/rpc/internal-channel.ts";

export function admitInternalConnection(socket: Socket, onStream: (stream: Duplex) => void): void {
	const bootstrap = getInternalHostBootstrap();
	if (bootstrap === undefined) {
		onStream(socket);
		return;
	}
	void acceptInternalConnection(socket, bootstrap.key, { protocolVersion: 1 }).then(onStream, () => socket.destroy());
}
