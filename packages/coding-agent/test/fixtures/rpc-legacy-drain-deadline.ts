import { createServer } from "node:net";
import { GENERATION_HANDOFF_CAPABILITY } from "../../src/modes/rpc/host-decision.ts";

const socket = process.argv[2];
if (!socket) throw new Error("missing legacy socket");
process.on("SIGUSR1", () => process.send?.({ type: "drain" }));
createServer((peer) => {
	let buffer = "";
	peer.on("data", (chunk) => {
		buffer += chunk.toString();
		while (buffer.includes("\n")) {
			const end = buffer.indexOf("\n");
			const request = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			const data =
				request.type === "get_protocol_info"
					? { serverVersion: "legacy", capabilities: [GENERATION_HANDOFF_CAPABILITY] }
					: { sessions: [] };
			peer.write(
				`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
			);
		}
	});
}).listen(socket, () => process.send?.({ type: "ready" }));
