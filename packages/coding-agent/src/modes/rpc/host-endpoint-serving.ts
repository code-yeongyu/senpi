/**
 * Whether a public endpoint SERVES, judged by the socket and never by a pid (senpi#4769). One bounded probe, four
 * verdicts, so every ensure branch decides on the same observation:
 *
 *     absent    nothing accepts: no entry, or an entry nobody listens behind (refused)
 *     unserved  it accepted, then closed or reset the connection without answering, or answered only
 *               `host_unavailable` (a supervisor that cannot reach its host, senpi#7388) - a listener that can
 *               never serve this client, yet keeps the path so nothing else can bind it
 *     held      it accepted and kept the connection silent until the deadline: a live host whose loop is busy;
 *               the kernel completes the connect from the listen backlog without the host's event loop
 *     answered  any other line came back: something is serving the path
 *
 * Only `unserved` is new evidence; `held` and `answered` are the "accepts connections" every earlier check meant.
 * A named pipe and an abstract socket have no entry to read, and an entry this process cannot stat cannot be ruled
 * out, so all three read as `held`: never a reason to replace anything.
 */
import { createConnection } from "node:net";
import { PROBE_REQUEST_ID } from "./host-socket-request.ts";
import { statSocketIdentity } from "./socket-ownership.ts";

export type EndpointServing = "absent" | "unserved" | "held" | "answered";

/** Resolves when the probe's deadline passes; `signal` aborts once the probe settled first. Tests pass a virtual clock. */
export type ProbeExpiry = (ms: number, signal: AbortSignal) => Promise<void>;

/** Long enough for a supervisor's refusal to arrive, short enough for an ensure to wait on a silent host. */
const SERVING_PROBE_TIMEOUT_MS = 2_000;

export async function probeEndpointServing(
	socket: string,
	expiry: ProbeExpiry = realExpiry,
	timeoutMs = SERVING_PROBE_TIMEOUT_MS,
): Promise<EndpointServing> {
	if (process.platform === "win32" || socket.startsWith("\0")) return "held";
	const entry = await statSocketIdentity(socket).then(
		(identity) => (identity === undefined ? "absent" : "present"),
		() => "unknown",
	);
	if (entry === "absent") return "absent";
	if (entry === "unknown") return "held";
	const settled = new AbortController();
	try {
		return await Promise.race([
			askOnce(socket),
			expiry(timeoutMs, settled.signal).then((): EndpointServing => "held"),
		]);
	} finally {
		settled.abort();
	}
}

function askOnce(socketPath: string): Promise<EndpointServing> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let accepted = false;
		let buffer = "";
		const finish = (verdict: EndpointServing): void => {
			socket.destroy();
			resolve(verdict);
		};
		socket.once("connect", () => {
			accepted = true;
			socket.write(`${JSON.stringify({ id: PROBE_REQUEST_ID, type: "get_protocol_info", observe: true })}\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			finish(isHostUnavailable(buffer.slice(0, newline)) ? "unserved" : "answered");
		});
		socket.once("error", () => finish(accepted ? "unserved" : "absent"));
		socket.once("close", () => finish(accepted ? "unserved" : "absent"));
	});
}

function isHostUnavailable(line: string): boolean {
	try {
		const record: unknown = JSON.parse(line);
		return (
			typeof record === "object" &&
			record !== null &&
			"errorCode" in record &&
			record.errorCode === "host_unavailable"
		);
	} catch {
		return false;
	}
}

function realExpiry(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	});
}
