import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";

/** Local wire-level rejections: never contact a provider or consume real credentials. */
export async function startProviderProbeServers() {
	const requests: { readonly api: string; readonly path: string }[] = [];
	const bedrock = createServer((request, response) => {
		requests.push({ api: "bedrock-converse-stream", path: request.url ?? "" });
		request.resume();
		response.writeHead(403, {
			"content-type": "application/json",
			"x-amzn-errortype": "AccessDeniedException",
			"x-amzn-requestid": "local-provider-probe",
		});
		response.end(JSON.stringify({ __type: "AccessDeniedException", message: "Access denied for probe credentials" }));
	});
	const sessions = new Set<ServerHttp2Session>();
	const cursor = createHttp2Server();
	cursor.on("session", (session) => {
		sessions.add(session);
		session.once("close", () => sessions.delete(session));
	});
	cursor.on("stream", (stream: ServerHttp2Stream, headers) => {
		const path = String(headers[":path"]);
		requests.push({ api: "cursor-agent", path });
		stream.resume();
		stream.respond({
			":status": path === "/agent.v1.AgentService/Run" ? 401 : 404,
			"content-type": "application/connect+proto",
		});
		const rejection = Buffer.from(
			JSON.stringify({ error: { code: "unauthenticated", message: "Invalid probe credentials" } }),
		);
		const frame = Buffer.alloc(5);
		frame[0] = 2;
		frame.writeUInt32BE(rejection.length, 1);
		stream.end(Buffer.concat([frame, rejection]));
	});
	const devin = createServer((request, response) => {
		requests.push({ api: "devin-agent", path: request.url ?? "" });
		request.resume();
		response.writeHead(401, { "content-type": "application/json" });
		response.end(JSON.stringify({ code: "unauthenticated", message: "Invalid probe credentials" }));
	});
	const servers = [bedrock, cursor, devin];
	const close = async (): Promise<void> => {
		const closed = Promise.all(
			servers
				.filter((server) => server.listening)
				.map(
					(server) =>
						new Promise<void>((resolve, reject) => {
							server.close((error) => (error ? reject(error) : resolve()));
						}),
				),
		);
		for (const session of sessions) session.destroy();
		bedrock.closeAllConnections();
		devin.closeAllConnections();
		await closed;
	};
	try {
		await Promise.all(
			servers.map(async (server) => {
				const listening = once(server, "listening", { signal: AbortSignal.timeout(5000) });
				server.listen(0, "127.0.0.1");
				await listening;
			}),
		);
		const urls = servers.map((server) => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Probe server did not bind a TCP port");
			return `http://127.0.0.1:${address.port}`;
		});
		return {
			models: ["bedrock-converse-stream", "cursor-agent", "devin-agent"].map((api, index) => ({
				api,
				baseUrl: urls[index],
				id: `probe-${index}`,
				provider: `probe-${index}`,
			})),
			requests,
			[Symbol.asyncDispose]: close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
