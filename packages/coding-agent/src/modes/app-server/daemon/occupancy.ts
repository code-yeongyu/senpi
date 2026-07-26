import { createServer, type Server } from "node:net";
import type { AppServerListen } from "../index.ts";
import { probeListen } from "./probe.ts";

type DaemonProbePaths = {
	readonly tokenFile: string;
};

export type AppServerListenOccupancy =
	| { readonly kind: "app-server"; readonly version: string }
	| { readonly kind: "available" };

export class AppServerDaemonAddressInUseError extends Error {
	readonly code = "EADDRINUSE";

	constructor(listen: AppServerListen) {
		super(
			`EADDRINUSE: app-server daemon cannot listen on ${listen.url}; the TCP address is occupied by a listener that did not answer initialize.`,
		);
		this.name = "AppServerDaemonAddressInUseError";
	}
}

/**
 * Classify an app-server listener before spawning a daemon. A compatible
 * app-server owns the address legitimately; any other TCP owner is reported
 * now instead of consuming the daemon child's readiness budget.
 */
export async function inspectAppServerListenOccupancy(
	paths: DaemonProbePaths,
	listen: AppServerListen,
): Promise<AppServerListenOccupancy> {
	const version = await probeListen(paths, listen, 2_000);
	if (version) return { kind: "app-server", version };
	if (listen.kind === "ws") await assertTcpAddressAvailable(listen);
	return { kind: "available" };
}

async function assertTcpAddressAvailable(listen: Extract<AppServerListen, { readonly kind: "ws" }>): Promise<void> {
	const server = createServer();
	try {
		await listenServer(server, listen.host, listen.port);
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "EADDRINUSE")) throw new AppServerDaemonAddressInUseError(listen);
		throw error;
	} finally {
		if (server.listening) await closeServer(server);
	}
}

function listenServer(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolveListen, rejectListen) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			rejectListen(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolveListen();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
