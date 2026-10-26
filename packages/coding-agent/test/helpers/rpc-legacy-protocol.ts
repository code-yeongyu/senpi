import type { Socket } from "node:net";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

/**
 * A fake socket host answers the client's first frame the way a host without endpoint authentication does: a
 * successful `get_protocol_info` with no `data.auth`, after which the client continues unauthenticated (wire
 * contract v1.1, frame 2). Returns whether `request` was that frame, so the fake skips its own handling.
 */
export function answerProtocolInfo(
	socket: Socket,
	request: { readonly id?: unknown; readonly type?: unknown },
): boolean {
	if (request.type !== "get_protocol_info") return false;
	socket.write(
		`${JSON.stringify({
			type: "response",
			id: request.id,
			command: "get_protocol_info",
			success: true,
			data: { protocolVersion: 1, capabilities: [] },
		})}\n`,
	);
	return true;
}

export function serveProtocolInfo(socket: Socket): void {
	attachJsonlLineReader(socket, (line) => {
		answerProtocolInfo(socket, JSON.parse(line) as { id?: unknown; type?: unknown });
	});
}
