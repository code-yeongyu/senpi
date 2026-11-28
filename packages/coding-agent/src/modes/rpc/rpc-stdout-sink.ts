import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { toJsonEvent } from "../json-event.ts";
import type { RpcConnectionSink } from "./connection-handler.ts";

export interface RpcStdoutIo {
	write(chunk: string): void;
	waitForBackpressure(): Promise<void>;
	/** Ends the host; called once a stream event cannot be serialized. */
	shutdown(exitCode: number): void;
}

/**
 * The stdio RPC host's sink: one JSON line per record, `message_update` events through their JSON projection. An event
 * the projection rejects is answered on the wire as `invalid_stream_event` and ends the host, instead of the error
 * escaping the event flush.
 */
export function createRpcStdoutSink(io: RpcStdoutIo): RpcConnectionSink {
	return {
		writeRaw: (chunk) => {
			const linearized = chunk
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const value = JSON.parse(line) as { type?: string; sessionId?: string };
					try {
						return JSON.stringify(
							value.type === "message_update" ? toJsonEvent(value as AgentSessionEvent) : value,
						);
					} catch (error) {
						if (!(error instanceof Error)) throw error;
						queueMicrotask(() => io.shutdown(1));
						return JSON.stringify({
							type: "response",
							command: "prompt",
							success: false,
							errorCode: "invalid_stream_event",
							error: error.message,
							sessionId: value.sessionId,
						});
					}
				})
				.join("\n");
			io.write(linearized.length > 0 ? `${linearized}\n` : "");
		},
		waitForBackpressure: () => io.waitForBackpressure(),
	};
}
