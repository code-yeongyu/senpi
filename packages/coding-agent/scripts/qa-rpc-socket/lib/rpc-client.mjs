/**
 * The JSONL RPC client of the offload harness and the QA driver. It sends only the commands listed
 * in `HARNESS_RPC_COMMANDS` (each one an `RpcCommand` of `src/modes/rpc/rpc-types.ts`, asserted by a
 * test) and refuses anything else before writing it. Records are delivered to subscribers in arrival
 * order; responses are correlated by id with a bounded deadline.
 */
import { createConnection } from "node:net";

export const HARNESS_RPC_COMMANDS = Object.freeze([
	"get_protocol_info",
	"open_session",
	"prompt",
	"compact",
	"close_session",
	"get_state",
	"get_entries",
	"list_sessions",
	"abort",
]);

const KNOWN = new Set(HARNESS_RPC_COMMANDS);

export function connectSocket(socketPath) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

export async function connectRpc(socketPath, { connect = connectSocket, label = "rpc" } = {}) {
	const socket = await connect(socketPath);
	let serial = 0;
	let buffer = "";
	const pending = new Map();
	const subscribers = new Set();
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			const record = JSON.parse(line);
			if (record.type === "response" && typeof record.id === "string" && pending.has(record.id)) {
				pending.get(record.id)(record);
				pending.delete(record.id);
				continue;
			}
			for (const subscriber of [...subscribers]) subscriber(record);
		}
	});
	const write = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
	return {
		request(command, timeoutMs = 120_000) {
			if (!KNOWN.has(command.type)) throw new Error(`harness RPC refuses unknown command ${command.type}`);
			const id = `${label}-${++serial}`;
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					resolve({ type: "response", id, command: command.type, success: false, error: "driver_timeout" });
				}, timeoutMs);
				pending.set(id, (record) => {
					clearTimeout(timer);
					resolve(record);
				});
				write({ ...command, id });
			});
		},
		respondUi(id, value, sessionId) {
			write({ type: "extension_ui_response", id, value, ...(sessionId ? { sessionId } : {}) });
		},
		subscribe(subscriber) {
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
		close() {
			socket.end();
			socket.destroy();
		},
	};
}
