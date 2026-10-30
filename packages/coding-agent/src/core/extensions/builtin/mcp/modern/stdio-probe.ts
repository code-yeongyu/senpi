import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ConnectError } from "../errors.ts";
import type { McpLogger } from "../log.ts";
import { reapProcessTree } from "../process-tree.ts";
import {
	type DiscoveryResult,
	discoveryReply,
	type ProbeOptions,
	type ProbeRequest,
	probeStdioEra,
	STDIO_PROBE_ID,
	StdioProbeSilence,
} from "./era.ts";
import { modernInitializeResult, normalizeModernResult } from "./sdk-bridge.ts";
import { ModernTransportError } from "./transport.ts";
import { ModernSubscriptions } from "./subscriptions.ts";
import { sanitizeModernMessage } from "./diagnostics.ts";
import { McpMrtrError } from "./errors.ts";
import { getModernDispatchGuard } from "./request.ts";
import { MODERN_PROTOCOL_VERSION, modernizeRequest } from "./wire.ts";

/** How long a stdio child gets to answer discovery (at most a quarter of the connect timeout) before it is treated as legacy. */
export const STDIO_PROBE_MS = 2_000;

/**
 * Probe the SDK's own child before initialize. A modern child keeps its process: `initialize` is answered
 * locally from discovery and every later request carries the per-request `_meta` at the negotiated version.
 * A clean non-modern error reply, or no reply in time (a slow start, or a server that ignores unknown requests),
 * keeps the same process for the legacy handshake; a discovery reply that arrives late still upgrades it to modern.
 * Only a child that exited or wrote non-JSON to stdout is replaced by a fresh process for the legacy handshake.
 */
export function probeStdioTransport(
	transport: Transport,
	options: ProbeOptions,
	logger: McpLogger,
	timeoutMs: number,
	serverName: string,
	onModern?: (version: string) => void,
	probeMs = STDIO_PROBE_MS,
	onLegacy?: () => void,
): void {
	const start = transport.start.bind(transport);
	const close = transport.close.bind(transport);
	const send = transport.send.bind(transport);
	const abort = new AbortController();
	transport.close = async () => {
		abort.abort();
		await close();
	};
	transport.start = async () => {
		await start();
		const outcome = await probeStdioEra(exchange, options);
		abort.signal.throwIfAborted();
		if (outcome.kind === "legacy-fallback") {
			if (outcome.restart) await restart();
			else if (outcome.silent) awaitLateDiscovery();
			if (!outcome.silent) onLegacy?.();
			return;
		}
		if (outcome.kind === "indeterminate" || !outcome.discovery) {
			const reason =
				outcome.kind === "indeterminate" ? `${outcome.reason}. ${outcome.action}` : outcome.error?.message;
			const message = `MCP server ${serverName} modern discovery failed: ${reason}`;
			logger.error(message);
			throw new ConnectError(message, { phase: "modern-stdio", serverName });
		}
		speakModern(outcome.discovery, outcome.version);
		onModern?.(outcome.version);
	};

	/** One discovery exchange, bounded; never reaches the SDK's handlers. */
	async function exchange(request: ProbeRequest): Promise<unknown> {
		const reply = Promise.withResolvers<unknown>();
		const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(probeMs, Math.floor(timeoutMs / 4)))]);
		const onabort = () => reply.reject(abort.signal.aborted ? abort.signal.reason : new StdioProbeSilence());
		const { onmessage, onclose, onerror } = transport;
		signal.addEventListener("abort", onabort, { once: true });
		transport.onmessage = (message, extra) => {
			if ("id" in message && !("method" in message) && message.id === request.id) reply.resolve(message);
			else onmessage?.(message, extra);
		};
		transport.onclose = () => reply.reject(new ModernTransportError("MCP stdio closed during discovery"));
		transport.onerror = (error) => reply.reject(error);
		try {
			signal.throwIfAborted();
			void send(request).catch(reply.reject);
			return await reply.promise;
		} finally {
			signal.removeEventListener("abort", onabort);
			transport.onmessage = onmessage;
			transport.onclose = onclose;
			transport.onerror = onerror;
		}
	}

	async function restart(): Promise<void> {
		logger.info(`MCP server ${serverName}: no clean discovery answer; restarting it for the legacy handshake`);
		// The old child's close event is not the connection closing; swallow exactly that one event.
		const pid = (transport as { readonly pid?: number | null }).pid;
		let stale = pid == null ? 0 : 1;
		const onclose = transport.onclose;
		transport.onclose = () => {
			if (stale > 0) stale--;
			else onclose?.();
		};
		// Kill the probed tree outright: a silent child may ignore the SDK's graceful stdin-close for seconds.
		if (pid != null) await reapProcessTree(pid, { termWaitMs: 200, killWaitMs: 200 });
		await close();
		// SDK close() resolves only after the old child's close event, so nothing stale can arrive later.
		stale = 0;
		abort.signal.throwIfAborted();
		await start();
		// A dispose during the respawn found no process to close; close the one it raced with.
		if (abort.signal.aborted) {
			await close();
			abort.signal.throwIfAborted();
		}
	}

	/**
	 * A silent child gets the SDK's legacy initialize on the same stream; a slow start is never killed. Until the
	 * first reply to the SDK arrives the probe window is still open: an exit or non-JSON stdout then restarts the
	 * child and replays initialize on the fresh process. A complete discovery reply that arrives late upgrades the
	 * stream to modern when the server rejects initialize (any error: a legacy server cannot produce a complete
	 * discovery). This relies on the server answering in order, as stdio servers do. Once settled, the wrappers
	 * are removed.
	 */
	function awaitLateDiscovery(): void {
		const { onmessage: deliver, onclose, onerror } = transport;
		let late: DiscoveryResult | undefined;
		let initialize: JSONRPCMessage | undefined;
		let initializeId: string | number | undefined;
		// Set while the child is replaced; sends that arrive meanwhile wait for the fresh process.
		let restarting: Promise<void> | undefined;
		const settle = () => {
			transport.onmessage = deliver;
			transport.onclose = onclose;
			transport.onerror = onerror;
			transport.send = send;
		};
		const unclean = (report: () => void) => {
			if (restarting) return report();
			// Only an initialize sent before the old child died needs replaying; a later one waits and goes once.
			const replay = initialize;
			restarting = (async () => {
				try {
					await restart();
					if (replay) await send(replay);
				} catch (error) {
					// A dispose during the window is not a failure to report.
					if (!abort.signal.aborted) onerror?.(error instanceof Error ? error : new Error(String(error)));
					onclose?.();
				}
			})();
		};
		transport.onclose = () => unclean(() => onclose?.());
		transport.onerror = (error) => unclean(() => onerror?.(error));
		transport.onmessage = (message, extra) => {
			if ("id" in message && !("method" in message) && typeof message.id === "string") {
				if (message.id.startsWith(STDIO_PROBE_ID)) {
					late ??= discoveryReply(message, message.id);
					return;
				}
			}
			const isInitializeReply = initializeId !== undefined && "id" in message && message.id === initializeId;
			if (
				isInitializeReply &&
				late &&
				"error" in message &&
				late.supportedVersions.includes(MODERN_PROTOCOL_VERSION)
			) {
				const discovery = late;
				logger.info(`MCP server ${serverName}: late discovery reply; switching to modern`);
				settle();
				speakModern(discovery, MODERN_PROTOCOL_VERSION);
				onModern?.(MODERN_PROTOCOL_VERSION);
				deliver?.(
					{
						jsonrpc: "2.0",
						id: initializeId as string | number,
						result: modernInitializeResult(discovery, MODERN_PROTOCOL_VERSION),
					},
					extra,
				);
				return;
			}
			if (isInitializeReply) {
				settle();
				onLegacy?.();
			}
			deliver?.(message, extra);
		};
		transport.send = async (message, sendOptions) => {
			if ("method" in message && message.method === "initialize" && "id" in message) {
				initialize = message;
				initializeId = message.id;
			}
			if (restarting) await restarting;
			return send(message, sendOptions);
		};
	}

	function speakModern(discovery: DiscoveryResult, version: string): void {
		const initializeResult = modernInitializeResult(discovery, version);
		const deliver = transport.onmessage;
		const live = new Set<string | number>();
		const subscriptions = new ModernSubscriptions(
			(message, options) => transport.send(message, options),
			discovery.capabilities,
		);
		const end = transport.close.bind(transport);
		transport.close = async () => {
			subscriptions.dispose();
			await end();
		};
		const onclose = transport.onclose;
		transport.onclose = () => {
			subscriptions.dispose();
			onclose?.();
		};
		let initialized = false;
		transport.onerror = () => {
			// A parser error may quote a wire body; never forward it.
			const failure = new McpMrtrError("MCP_MRTR_TRANSPORT_FAILED");
			logger.warn(failure.message);
			void transport.close();
		};
		transport.onmessage = (message, extra) => {
			if ("id" in message && "method" in message) {
				void send({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: "Unsupported MCP method." },
				}).catch(() => {});
				return;
			}
			if ("id" in message && message.id !== undefined && !live.delete(message.id)) return;
			if (!subscriptions.incoming(message)) {
				const id =
					"method" in message && message.method === "notifications/cancelled"
						? message.params?.requestId
						: undefined;
				if (typeof id === "string" || typeof id === "number") live.delete(id);
				return;
			}
			if ("method" in message && message.method === "notifications/progress") {
				const token = message.params?.progressToken;
				if ((typeof token !== "string" && typeof token !== "number") || !live.has(token)) return;
			}
			const safe = sanitizeModernMessage(message);
			if (safe) deliver?.(normalizeModernResult(safe), extra);
		};
		transport.send = async (message, sendOptions) => {
			if (!("method" in message)) return send(message, sendOptions);
			if (message.method === "initialize") {
				if (!("id" in message) || initialized) {
					throw new ModernTransportError("Modern MCP stdio has already initialized");
				}
				initialized = true;
				deliver?.({ jsonrpc: "2.0", id: message.id, result: initializeResult });
				return;
			}
			if (message.method === "notifications/initialized" && !("id" in message)) return;
			if (message.method === "notifications/cancelled" && !("id" in message)) {
				subscriptions.outgoing(message);
				const id = message.params?.requestId;
				if ((typeof id !== "string" && typeof id !== "number") || !live.delete(id)) return;
				return send(
					{ jsonrpc: "2.0", method: message.method, params: { requestId: id, reason: "MCP request canceled" } },
					sendOptions,
				);
			}
			getModernDispatchGuard(message.params)?.();
			subscriptions.outgoing(message);
			const request = modernizeRequest(
				"id" in message ? message.id : 0,
				message.method,
				options.clientInfo,
				options.clientCapabilities,
				version,
				message.params,
			);
			if ("id" in message) {
				live.add(message.id);
				try {
					return await send(request, sendOptions);
				} catch {
					live.delete(message.id);
					subscriptions.failedSend(message);
					throw new McpMrtrError("MCP_MRTR_TRANSPORT_FAILED");
				}
			}
			const { id: _id, ...notification } = request;
			return send(notification, sendOptions);
		};
	}
}
