/**
 * Session driving for the offload profiler: N sessions, each on its own connection, run the
 * workload; every `tool_execution_end` of a session is recorded, `agent_settled` resolves the
 * session, and permission selects are answered "Allow always". A probe connection sends
 * `get_protocol_info` back to back with a 100 ms gap; its latency is how long the loop made other
 * clients wait, tagged with the phase it was sent in.
 */
import { MOCK_MODEL, MOCK_PROVIDER } from "./qa-host.mjs";
import { connectRpc } from "./rpc-client.mjs";

export async function openSessions({ socket, count, cwd }) {
	return Promise.all(
		Array.from({ length: count }, async (_, n) => {
			const rpc = await connectRpc(socket, { label: `s${n}` });
			const started = performance.now();
			const opened = await rpc.request({ type: "open_session", cwd, permissionPreset: "auto", provider: MOCK_PROVIDER, modelId: MOCK_MODEL });
			if (opened.success !== true) throw new Error(`open_session ${n} failed: ${JSON.stringify(opened.error ?? opened).slice(0, 400)}`);
			const session = { n, rpc, sessionId: opened.data.sessionId, openMs: Math.round(performance.now() - started), toolEvents: [], settled: false };
			let markSettled = () => undefined;
			session.settledPromise = new Promise((resolve) => (markSettled = resolve));
			rpc.subscribe((record) => {
				if (record.type === "extension_ui_request" && record.method === "select" && record.options?.includes?.("Allow always")) {
					rpc.respondUi(record.id, "Allow always", record.sessionId);
				}
				if (record.sessionId !== session.sessionId) return;
				if (record.type === "tool_execution_end") session.toolEvents.push({ tool: record.toolName, isError: record.isError === true });
				if (record.type === "agent_settled") {
					session.settled = true;
					markSettled();
				}
			});
			return session;
		}),
	);
}

/** Prompts every session and waits for all to settle or for the bounded turn deadline. */
export async function runTurns(sessions, promptFor, turnTimeoutMs) {
	await Promise.all(sessions.map((s) => s.rpc.request({ type: "prompt", sessionId: s.sessionId, message: promptFor(s.n) })));
	let timer;
	const deadline = new Promise((resolve) => (timer = setTimeout(resolve, turnTimeoutMs)));
	await Promise.race([Promise.all(sessions.map((s) => s.settledPromise)), deadline]);
	clearTimeout(timer);
}

export async function compactAll(sessions) {
	return Promise.all(
		sessions.map(async (s) => {
			if (!s.settled) return { n: s.n, success: false, error: "turn_not_settled" };
			const response = await s.rpc.request({ type: "compact", sessionId: s.sessionId }, 300_000);
			return { n: s.n, success: response.success === true, ...(response.success ? {} : { error: String(response.error).slice(0, 300) }) };
		}),
	);
}

export async function closeAll(sessions) {
	for (const s of sessions) {
		await s.rpc.request({ type: "close_session", sessionId: s.sessionId }, 60_000);
		s.rpc.close();
	}
}

export async function startProbe(socket) {
	const rpc = await connectRpc(socket, { label: "probe" });
	const series = [];
	let phase = "idle";
	let running = true;
	const loop = (async () => {
		while (running) {
			const sentAt = performance.now();
			const sentPhase = phase;
			await rpc.request({ type: "get_protocol_info" }, 120_000);
			series.push({ phase: sentPhase, ms: Math.round(performance.now() - sentAt) });
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	})();
	return {
		setPhase: (next) => (phase = next),
		async stop() {
			running = false;
			await loop;
			rpc.close();
			return series;
		},
	};
}

export function percentiles(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null;
	return { count: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) ?? null };
}
