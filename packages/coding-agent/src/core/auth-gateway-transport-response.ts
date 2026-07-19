import type { ServerResponse } from "node:http";
import type { AuthGatewaySseFrame, AuthGatewayTransportResponse } from "./auth-gateway-transport-types.ts";

export async function writeGatewayResponse(
	response: ServerResponse,
	result: AuthGatewayTransportResponse,
	signal: AbortSignal,
	headers: Readonly<Record<string, string>>,
): Promise<void> {
	const frames = result.frames;
	if (frames !== undefined) {
		await writeSse(response, frames, signal, headers);
		return;
	}
	writeJson(response, result.statusCode, result.body ?? null, headers);
}

export function writeJson(
	response: ServerResponse,
	statusCode: number,
	body: unknown,
	headers: Readonly<Record<string, string>> | undefined = undefined,
): void {
	if (response.writableEnded) return;
	response
		.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...headers })
		.end(JSON.stringify(body));
}

async function writeSse(
	response: ServerResponse,
	frames: AsyncIterable<AuthGatewaySseFrame>,
	signal: AbortSignal,
	headers: Readonly<Record<string, string>>,
): Promise<void> {
	response.writeHead(200, {
		"cache-control": "no-cache",
		"content-type": "text/event-stream; charset=utf-8",
		...headers,
	});
	for await (const frame of frames) {
		if (signal.aborted || response.writableEnded) return;
		const event = frame.event === undefined ? "" : `event: ${frame.event}\n`;
		const data = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
		if (!response.write(`${event}data: ${data}\n\n`)) {
			await waitForDrainOrClose(response);
		}
	}
	if (!signal.aborted && !response.writableEnded) response.end();
}

/** Wait for drain or close and always remove the losing listener. */
function waitForDrainOrClose(response: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const onDrain = () => {
			response.off("close", onClose);
			resolve();
		};
		const onClose = () => {
			response.off("drain", onDrain);
			resolve();
		};
		response.once("drain", onDrain);
		response.once("close", onClose);
	});
}
