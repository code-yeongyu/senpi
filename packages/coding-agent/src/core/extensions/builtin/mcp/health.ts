import type { ServerConnection } from "./connection.ts";
import { ConnectError, isMcpSessionExpiredError, isRetriableMcpError, SessionExpiredError } from "./errors.ts";

export const MCP_PING_STALE_MS = 30_000;
export const MCP_PING_TIMEOUT_MS = 2_000;

interface McpHealthState {
	lastSuccessfulPingAtMs: number | undefined;
	pendingValidation: Promise<void> | undefined;
}

const healthByConnection = new WeakMap<ServerConnection, McpHealthState>();

export async function ensureMcpToolCallConnection(connection: ServerConnection): Promise<void> {
	const health = healthStateFor(connection);
	if (connection.state !== "connected") {
		if (connection.state === "idle" || connection.state === "connecting") {
			await connection.connect();
		} else {
			await renewConnection(connection, health);
			return;
		}
	}
	const lastSuccessfulPingAtMs = health.lastSuccessfulPingAtMs;
	if (lastSuccessfulPingAtMs !== undefined && Date.now() - lastSuccessfulPingAtMs <= MCP_PING_STALE_MS) {
		return;
	}
	if (health.pendingValidation !== undefined) {
		await health.pendingValidation;
		return;
	}
	const pendingValidation = pingOrRenew(connection, health).finally(() => {
		if (health.pendingValidation === pendingValidation) health.pendingValidation = undefined;
	});
	health.pendingValidation = pendingValidation;
	await pendingValidation;
}

export async function withMcpSessionExpiryRetry<T>(
	connection: ServerConnection,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isMcpSessionExpiredError(error)) throw error;
		connection.markDegraded(sessionExpiredError(connection, error, true));
		await connection.renew();
		try {
			return await operation();
		} catch (retryError) {
			if (!isMcpSessionExpiredError(retryError)) throw retryError;
			const expired = sessionExpiredError(connection, retryError, false);
			connection.markSuspended(expired);
			throw expired;
		}
	}
}

export async function withMcpRetriableFailedSendRetry<T>(
	connection: ServerConnection,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isRetriableFailedSendError(error)) throw error;
		connection.markDegraded(failedSendError(connection, error, true));
		await connection.renew();
		try {
			return await operation();
		} catch (retryError) {
			if (isRetriableFailedSendError(retryError)) {
				connection.markDegraded(failedSendError(connection, retryError, false));
			}
			throw retryError;
		}
	}
}

function healthStateFor(connection: ServerConnection): McpHealthState {
	let health = healthByConnection.get(connection);
	if (health === undefined) {
		health = { lastSuccessfulPingAtMs: undefined, pendingValidation: undefined };
		healthByConnection.set(connection, health);
	}
	return health;
}

async function pingOrRenew(connection: ServerConnection, health: McpHealthState): Promise<void> {
	try {
		await connection.client.ping({ timeout: MCP_PING_TIMEOUT_MS });
		health.lastSuccessfulPingAtMs = Date.now();
	} catch (error) {
		connection.markDegraded(error instanceof Error ? error : new Error(String(error)));
		await renewConnection(connection, health);
	}
}

async function renewConnection(connection: ServerConnection, health: McpHealthState): Promise<void> {
	await connection.renew();
	health.lastSuccessfulPingAtMs = Date.now();
}

function isRetriableFailedSendError(error: unknown): boolean {
	return isRetriableMcpError(error) && !isMcpSessionExpiredError(error);
}

function failedSendError(connection: ServerConnection, cause: unknown, retriable: boolean): ConnectError {
	const suffix = retriable
		? "reconnecting once before retry"
		: `post-reconnect retry also failed; run /mcp reconnect ${connection.serverName}`;
	return new ConnectError(`MCP server ${connection.serverName} failed to send tool call; ${suffix}`, {
		cause,
		phase: "call",
		retriable,
		serverName: connection.serverName,
	});
}

function sessionExpiredError(connection: ServerConnection, cause: unknown, retriable: boolean): SessionExpiredError {
	const suffix = retriable
		? "reinitializing once"
		: `reinitialize retry also expired; run /mcp reconnect ${connection.serverName}`;
	return new SessionExpiredError(`MCP server ${connection.serverName} session expired; ${suffix}`, {
		cause,
		phase: "session",
		retriable,
		serverName: connection.serverName,
	});
}
