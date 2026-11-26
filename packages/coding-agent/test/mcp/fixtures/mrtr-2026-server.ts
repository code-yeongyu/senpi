import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface FixtureRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export const formInput = (message = "synthetic question") => ({
	method: "elicitation/create",
	params: { message, requestedSchema: { type: "object", properties: { value: { type: "string" } } } },
});
export const inputResult = (
	state = " opaque \u2603 state ",
	inputs: Record<string, unknown> = { question: formInput() },
) => ({
	resultType: "input_required",
	requestState: state,
	inputRequests: inputs,
});

/** Raw modern protocol, deliberately independent of the legacy SDK Server. */
export class MrtrScript {
	readonly requests: FixtureRequest[] = [];
	readonly methods = new Set(["tools/call", "resources/read", "prompts/get"]);
	outputSchema?: Record<string, unknown>;
	tools?: unknown[];
	onRequest?: (request: FixtureRequest) => Promise<void>;
	disconnectAfterRound?: number;
	continuationStatus?: 401 | 403;
	readonly notifications: Array<Record<string, unknown>> = [];
	readonly barriers = new Map<string, Array<(request: FixtureRequest) => void>>();
	readonly results: unknown[];
	constructor(results: unknown[] = [inputResult()]) {
		this.results = results;
	}
	next(event: string): Promise<FixtureRequest> {
		return new Promise((resolve) => {
			const listeners = this.barriers.get(event) ?? [];
			listeners.push(resolve);
			this.barriers.set(event, listeners);
		});
	}
	emit(event: string, request: FixtureRequest): void {
		for (const resolve of this.barriers.get(event) ?? []) resolve(request);
		this.barriers.delete(event);
	}
	reply(request: FixtureRequest): Record<string, unknown> {
		this.emit("requestReceived", request);
		const params = request.params ?? {};
		const meta = params._meta as Record<string, unknown> | undefined;
		if (
			meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" ||
			typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object"
		) {
			return { jsonrpc: "2.0", id: request.id, error: { code: -32020, message: "invalid metadata" } };
		}
		const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
		if (request.method === "server/discover")
			return result({
				resultType: "complete",
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {}, resources: {}, prompts: {} },
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "synthetic", version: "1" } },
			});
		if (request.method === "tools/list" && !this.methods.has("tools/list"))
			return result({
				tools: this.tools ?? [
					{
						name: "fixture",
						inputSchema: { type: "object" },
						...(this.outputSchema === undefined ? {} : { outputSchema: this.outputSchema }),
					},
				],
			});
		if (request.method === "prompts/list" && !this.methods.has(request.method))
			return result({ prompts: [{ name: "fixture", description: "Synthetic MRTR form" }] });
		if (request.method === "resources/list" && !this.methods.has(request.method))
			return result({ resources: [{ name: "fixture", uri: "test://fixture" }] });
		if (request.method === "resources/templates/list" && !this.methods.has(request.method))
			return result({ resourceTemplates: [] });
		if (request.method === "ping") return result({});
		const application = this.methods.has(request.method);
		if (!application) return result({});
		const round = this.requests.length;
		this.requests.push(request);
		if (round > 0) this.emit("continuationReceived", request);
		const intermediate = this.results[round];
		if (intermediate !== undefined) {
			this.emit("inputResultSent", request);
			return result(intermediate);
		}
		if (request.method === "resources/read")
			return result({ resultType: "complete", contents: [{ uri: params.uri, text: "final resource" }] });
		if (request.method === "prompts/get")
			return result({
				resultType: "complete",
				messages: [{ role: "user", content: { type: "text", text: "final prompt" } }],
			});
		return result({ resultType: "complete", content: [{ type: "text", text: "final tool" }] });
	}
}

export async function startMrtrServer(script: MrtrScript, sse = false) {
	const server = createServer(async (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString()) as FixtureRequest;
		await script.onRequest?.(message);
		if (message.method === "notifications/cancelled") {
			script.emit("cancelReceived", message);
			response.writeHead(204).end();
			return;
		}
		const reply = script.reply(message);
		if (script.continuationStatus && message.params?.requestState !== undefined) {
			response
				.writeHead(script.continuationStatus, { "WWW-Authenticate": 'Bearer error="insufficient_scope"' })
				.end();
			return;
		}
		if (script.disconnectAfterRound !== undefined && script.requests.length > script.disconnectAfterRound) {
			response.destroy();
			return;
		}
		response.on("close", () => script.emit("streamClosed", message));
		response.writeHead(200, { "Content-Type": sse ? "text/event-stream" : "application/json" });
		response.end(
			sse
				? [...script.notifications, reply].map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("")
				: JSON.stringify(reply),
		);
		script.emit("responseReleased", message);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Fixture listener missing");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.stderr.write("PRIVATE_STDERR_CANARY\n");
	const script = new MrtrScript(JSON.parse(process.argv[2] ?? "[]") as unknown[]);
	const input = createInterface({ input: process.stdin });
	input.on("line", (line) => {
		const request = JSON.parse(line) as FixtureRequest;
		if (request.method === "notifications/cancelled") return;
		process.stdout.write(`${JSON.stringify(script.reply(request))}\n`);
	});
}
