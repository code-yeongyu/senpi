import { createServer, type RequestListener, type Server } from "node:http";

/** Node-only callback dependency reached through the opaque OAuth loaders in load.ts. */
export type GoogleOAuthServer = Server;

export function createGoogleOAuthServer(listener: RequestListener): Server {
	return createServer(listener);
}
