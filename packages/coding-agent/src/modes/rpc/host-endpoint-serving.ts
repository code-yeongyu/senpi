/**
 * Whether a public endpoint SERVES, judged by the socket and never by a pid (senpi#4769). Verdicts:
 *
 *     absent    nothing accepts: no entry, or an entry nobody listens behind (refused)
 *     unserved  it accepted, then closed or reset the connection without answering, or answered only
 *               `host_unavailable` (a supervisor that cannot reach its host, senpi#7388), and was still doing so
 *               after the confirmation wait - a listener that can serve no client, yet keeps the path
 *     held      it accepted and kept the connection silent until the deadline: a live host whose loop is busy;
 *               the kernel completes the connect from the listen backlog without the host's event loop
 *     answered  any other line came back: something is serving the path
 *
 * A supervisor also answers `host_unavailable` for a TRANSIENT failure to reach its host (a full internal backlog,
 * the hop guard's re-bind window, senpi#7452), while connections it already proxies keep working. So one such answer
 * proves nothing: `unserved` needs the same verdict again after `UNSERVED_CONFIRM_MS`, longer than the hop guard's
 * re-check interval. Whatever the second probe sees is the verdict.
 *
 * A named pipe and an abstract socket have no entry to stat and their connect needs the transport the clients use, so
 * they get the plain reachability probe: `absent` or `held`, never `unserved`.
 */
import { createConnection } from "node:net";
import { probeSocketReachable } from "./host-probe.ts";
import { PROBE_REQUEST_ID } from "./host-socket-request.ts";
import { statSocketIdentity } from "./socket-ownership.ts";

export type EndpointServing = "absent" | "unserved" | "held" | "answered";

/**
 * The probe's time, injectable so a test drives it: `expire` resolves when a probe deadline passes (its `signal`
 * aborts once the probe settled first); `wait` is the confirmation wait between the two probes.
 */
export interface ServingProbeClock {
	readonly expire: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly wait: (ms: number) => Promise<void>;
}

/** Long enough for a supervisor's refusal to arrive, short enough for an ensure to wait on a silent host. */
const SERVING_PROBE_TIMEOUT_MS = 2_000;
/** Two hop-guard re-checks (`INTERNAL_HOP_GUARD_INTERVAL_MS`, 5 s) plus one probe, so a hop being restored is never read as lost. */
const UNSERVED_CONFIRM_MS = 12_000;

export async function probeEndpointServing(
	socket: string,
	clock: ServingProbeClock = { expire: expireAfter, wait: waitFor },
): Promise<EndpointServing> {
	if (process.platform === "win32" || socket.startsWith("\0"))
		return (await probeSocketReachable(socket, SERVING_PROBE_TIMEOUT_MS)) ? "held" : "absent";
	const first = await probeOnce(socket, clock);
	if (first !== "unserved") return first;
	await clock.wait(UNSERVED_CONFIRM_MS);
	return probeOnce(socket, clock);
}

async function probeOnce(socket: string, clock: ServingProbeClock): Promise<EndpointServing> {
	const entry = await statSocketIdentity(socket).then(
		(identity) => (identity === undefined ? "absent" : "present"),
		() => "unknown",
	);
	if (entry === "absent") return "absent";
	const settled = new AbortController();
	try {
		return await Promise.race([
			askOnce(socket),
			clock.expire(SERVING_PROBE_TIMEOUT_MS, settled.signal).then((): EndpointServing => "held"),
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

function expireAfter(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	});
}

function waitFor(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
