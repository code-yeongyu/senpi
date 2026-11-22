import fsPromises from "node:fs/promises";
import type net from "node:net";
import { mock } from "node:test";

/**
 * Whether the supervisor binds `socket` directly. A Windows named pipe or a Linux abstract socket (a name starting
 * with `\0`) has no filesystem entry, so the supervisor never links it into place (#5888).
 */
export function endpointBindsDirectly(socket: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" || socket.startsWith("\0");
}

/**
 * Signals `ready` once the public endpoint `socket` exists: at the server's `listening` for an endpoint bound
 * directly, else at the supervisor's `link` of its bound socket into `socket` (#5319, #5888). Call it before
 * `syncBuiltinESMExports()`, and pass every server the fixture's `net.createServer` mock creates to the returned hook.
 */
export function signalEndpointReady(socket: string, ready: () => void): (server: net.Server) => void {
	if (endpointBindsDirectly(socket)) return (server) => void server.once("listening", ready);
	const link = fsPromises.link;
	mock.method(fsPromises, "link", async (...args: Parameters<typeof link>) => {
		await link(...args);
		if (args[1] === socket) ready();
	});
	return () => {};
}
