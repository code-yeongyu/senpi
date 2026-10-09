/**
 * The session vocabulary this matrix drives a running daemon with, over real socket connections.
 *
 * Every command goes through the wire a client uses (`lib/jsonl-socket.mjs`), so a cell measures
 * what a client would see rather than what a host-internal call would return. A refused command
 * throws here instead of at the assertion, because a cell that silently continued past a refusal
 * would report a number about the wrong host state.
 */
import { connectJsonlSocket } from "./jsonl-socket.mjs";

const BUDGET_MS = 120_000;

/** Binds the vocabulary to one socket and one working directory; tracks every connection it opens. */
export function sessionDriver(socket, cwd) {
	const connections = [];
	const openCommand = (fields) => ({
		type: "open_session",
		cwd,
		provider: "mock",
		modelId: "mock-model",
		auto_title: false,
		...fields,
	});

	const rows = async (connection, includeWorkers) => {
		const response = await connection.request({ type: "list_sessions", include_workers: includeWorkers });
		return response.data.sessions;
	};

	return {
		async connect() {
			const connection = await connectJsonlSocket(socket, BUDGET_MS);
			connections.push(connection);
			return connection;
		},

		/** Opens a session and answers the host's own record of it (`sessionId`, `attached`). */
		async open(connection, fields) {
			const response = await connection.request(openCommand(fields));
			if (response.success !== true) throw new Error(`open_session failed: ${response.error}`);
			return response.data;
		},

		/** Answers the admission decision rather than throwing, so a host's cap stays a measurement. */
		async tryOpen(connection, fields) {
			const response = await connection.request(openCommand(fields));
			if (response.success === true) return { admitted: true, sessionId: response.data.sessionId };
			return { admitted: false, error: response.error };
		},

		/** The identity the session's OWN extension instance was constructed with. */
		async probe(connection, sessionId) {
			const response = await connection.request({ type: "extension_request", name: "probe.identity", sessionId });
			if (response.success !== true) throw new Error(`probe.identity failed: ${response.error}`);
			return response.data;
		},

		rows,

		/** One real turn against the mock provider, awaited on the host's own settlement record. */
		async turn(connection, sessionId, message) {
			const idle = connection.waitForRecord(sessionId, (record) => record.type === "agent_idle");
			const response = await connection.request({ type: "prompt", sessionId, message });
			if (response.success !== true) throw new Error(`prompt failed: ${response.error}`);
			await idle;
		},

		/** The host's own occupancy view, read until it reports the retained session at zero clients. */
		async awaitDetach(connection, sessionId, budgetMs = 30_000) {
			const deadline = Date.now() + budgetMs;
			while (Date.now() <= deadline) {
				const row = (await rows(connection, true)).find((entry) => entry.sessionId === sessionId);
				if (row?.attachments === 0) return true;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return false;
		},

		disposeAll() {
			for (const connection of connections.splice(0)) connection.dispose();
		},
	};
}
