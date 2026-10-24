import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnySchema, SchemaOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Request } from "@modelcontextprotocol/sdk/types.js";
import type { McpElicitationUiProvider } from "../elicitation.ts";
import { configureMcpElicitation, mcpClientCapabilities } from "../elicitation.ts";
import { type McpRequestOrigin, physicalMcpClient, takeMcpRequestOrigin } from "../request-origin.ts";
import { AuthError } from "../errors.ts";
import { loadMcpSdkClient, loadMcpSdkTypes, loadMcpSdkZodCompat } from "../sdk.lazy.ts";
import { type McpClock, mcpElapsedClock } from "../wrap.ts";
import { collectMrtrForm, isRecord, type MrtrInputResponse, validateMrtrForm } from "./elicitation.ts";
import { McpMrtrError } from "./errors.ts";

export const MAX_MCP_MRTR_ROUNDS = 8;
const capableMethods = new Set(["tools/call", "resources/read", "prompts/get"]);
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
/** Local dispatch guard survives SDK object spreads but is never JSON serialized. */
export const modernDispatchGuard = Symbol("mcp-modern-dispatch");
export interface ModernProtocolState {
	version?: string;
	legacy?: boolean;
	resolveStdioDiagnostics?: (modern: boolean) => void;
	activateRequests?: () => void;
}
export type MrtrClock = McpClock;
const states = new WeakMap<Client, ModernProtocolState>();
export const isModernMcpClient = (client: Client) => states.get(physicalMcpClient(client))?.version !== undefined;
const own = (value: object, key: string) => Object.hasOwn(value, key);
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function getModernDispatchGuard(params: unknown): ((credential?: string) => void) | undefined {
	return isRecord(params)
		? (params as { [modernDispatchGuard]?: (credential?: string) => void })[modernDispatchGuard]
		: undefined;
}

interface QueueJob {
	readonly signal: AbortSignal;
	readonly run: () => Promise<MrtrInputResponse>;
	readonly resolve: (value: MrtrInputResponse) => void;
	readonly reject: (error: unknown) => void;
	abort: () => void;
}
const queues = new WeakMap<object, { busy: boolean; jobs: QueueJob[] }>();
function queuedForm(binding: object, signal: AbortSignal, run: QueueJob["run"]): Promise<MrtrInputResponse> {
	let queue = queues.get(binding);
	if (!queue) {
		queue = { busy: false, jobs: [] };
		queues.set(binding, queue);
	}
	const current = queue;
	const pump = () => {
		if (current.busy) return;
		const next = current.jobs.shift();
		if (!next) {
			queues.delete(binding);
			return;
		}
		next.signal.removeEventListener("abort", next.abort);
		if (next.signal.aborted) {
			next.resolve({ action: "cancel" });
			pump();
			return;
		}
		current.busy = true;
		void next
			.run()
			.then(next.resolve, next.reject)
			.finally(() => {
				current.busy = false;
				pump();
			});
	};
	return new Promise((resolve, reject) => {
		const job: QueueJob = { signal, run, resolve, reject, abort: () => {} };
		job.abort = () => {
			const index = current.jobs.indexOf(job);
			if (index >= 0) {
				current.jobs.splice(index, 1);
				resolve({ action: "cancel" });
			}
		};
		current.jobs.push(job);
		signal.addEventListener("abort", job.abort, { once: true });
		if (signal.aborted) job.abort();
		pump();
	});
}

type Input = {
	method: "elicitation/create";
	params: { mode?: "form" | "url"; message: string; requestedSchema?: unknown };
};
function parseInputs(result: Record<string, unknown>): Map<string, Input> | undefined {
	if (!own(result, "requestState") && !own(result, "inputRequests")) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
	if (own(result, "requestState") && typeof result.requestState !== "string")
		throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
	if (
		byteSize(result) > 512 * 1024 ||
		(typeof result.requestState === "string" && Buffer.byteLength(result.requestState) > 64 * 1024)
	)
		throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
	if (!own(result, "inputRequests")) return undefined;
	if (!isRecord(result.inputRequests)) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
	const entries = Object.entries(result.inputRequests);
	if (entries.length > 32) throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
	// Scan the complete batch before collecting anything, including unsupported capability requests.
	for (const [, input] of entries)
		if (isRecord(input) && ["roots/list", "sampling/createMessage"].includes(String(input.method)))
			throw new McpMrtrError("MCP_MRTR_UNSUPPORTED_INPUT");
	const inputs = new Map<string, Input>();
	const checkStrings = (value: unknown): void => {
		if (typeof value === "string" && Buffer.byteLength(value) > 16 * 1024)
			throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
		if (Array.isArray(value)) for (const entry of value) checkStrings(entry);
		else if (isRecord(value))
			for (const [key, entry] of Object.entries(value)) {
				checkStrings(key);
				checkStrings(entry);
			}
	};
	for (const [key, input] of entries) {
		checkStrings(key);
		if (
			!isRecord(input) ||
			input.method !== "elicitation/create" ||
			!isRecord(input.params) ||
			typeof input.params.message !== "string"
		)
			throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
		const params = input.params;
		checkStrings(params);
		if (params.mode === "url") {
			if (typeof params.url !== "string" || typeof params.elicitationId !== "string")
				throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
			throw new McpMrtrError("MCP_MRTR_UNSUPPORTED_INPUT");
		} else {
			if (params.mode !== undefined && params.mode !== "form") throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
			if (
				isRecord(params.requestedSchema) &&
				isRecord(params.requestedSchema.properties) &&
				Object.keys(params.requestedSchema.properties).length > 64
			)
				throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
			if (!validateMrtrForm(params.requestedSchema)) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
		}
		inputs.set(key, input as unknown as Input);
	}
	return inputs;
}

export async function createMcpRequestClient(
	protocol: ModernProtocolState,
	uiProvider: McpElicitationUiProvider | undefined,
	readCredential: () => string | undefined = () => undefined,
	elicitationEnabled = true,
): Promise<Client> {
	const { Client } = await loadMcpSdkClient();
	const client = new Client(
		{ name: "senpi-mcp-client", version: "0.0.0" },
		{ capabilities: mcpClientCapabilities(elicitationEnabled) },
	);
	await configureMcpElicitation(client, uiProvider, undefined, elicitationEnabled);
	installModernRequestAdapter(client, protocol, mcpElapsedClock, readCredential);
	return client;
}

/** One instance-local adapter. Captured SDK requests retain ID allocation and final output-schema validation. */
export function installModernRequestAdapter(
	client: Client,
	protocol: ModernProtocolState,
	clock: MrtrClock = mcpElapsedClock,
	readCredential: () => string | undefined = () => undefined,
): void {
	const sdkRequest = client.request.bind(client);
	states.set(client, protocol);
	const requestWithMrtr: Client["request"] = async <T extends AnySchema>(
		request: Request,
		schema: T,
		options?: RequestOptions,
	): Promise<SchemaOutput<T>> => {
		if (protocol.version === undefined || request.method === "initialize")
			return sdkRequest(request, schema, options);
		const { origin, sdkOptions } = takeMcpRequestOrigin(options, client);
		if (own(request.params ?? {}, "requestState") || own(request.params ?? {}, "inputResponses") || options?.task)
			throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
		const params = structuredClone(request.params ?? {});
		const start = clock.now();
		const timeout = sdkOptions.timeout ?? 60_000;
		const duration = Math.min(sdkOptions.maxTotalTimeout ?? Infinity, 9 * timeout + 300_000);
		const deadline = start + duration;
		const operation = new AbortController();
		const credential = readCredential();
		let authority: string | undefined;
		let authorityCaptured = false;
		const controller = origin?.connection;
		const generation = controller?.generation;
		let presentationLost = origin?.presentation === undefined || origin.presentation.signal.aborted;
		let consentSpent = 0;
		let continuation: Record<string, unknown> = {};
		let failure: McpMrtrError | undefined;
		const stop = (code: ConstructorParameters<typeof McpMrtrError>[0]) => {
			failure ??= new McpMrtrError(code);
			operation.abort(failure);
		};
		const onCallerAbort = () => stop("MCP_MRTR_CANCELLED");
		const onOwnerAbort = () => stop("MCP_MRTR_CONTEXT_CHANGED");
		const onPresentationLost = () => {
			presentationLost = true;
		};
		const check = () => {
			if (clock.now() >= deadline) stop("MCP_MRTR_TIMEOUT");
			if (
				origin &&
				(!origin.isCurrent() ||
					origin.signal.aborted ||
					controller?.generation !== generation ||
					controller?.state !== "connected")
			)
				stop("MCP_MRTR_CONTEXT_CHANGED");
			if (failure) throw failure;
		};
		const resolveAuthority = async () => {
			check();
			if (origin) {
				const snapshot = JSON.stringify(
					await interrupted(origin.resolveAuthority(operation.signal), operation.signal),
				);
				if (!authorityCaptured) {
					authority = snapshot;
					authorityCaptured = true;
				} else if (authority !== snapshot) stop("MCP_MRTR_CONTEXT_CHANGED");
			}
			check();
		};
		const off = controller?.onStateChange(() => {
			try {
				check();
			} catch {
				/* Abort reaches the active attempt and consent. */
			}
		});
		sdkOptions.signal?.addEventListener("abort", onCallerAbort, { once: true });
		origin?.signal.addEventListener("abort", onOwnerAbort, { once: true });
		origin?.presentation?.signal.addEventListener("abort", onPresentationLost, { once: true });
		const timer = clock.schedule(() => stop("MCP_MRTR_TIMEOUT"), Math.max(0, duration));
		if (sdkOptions.signal?.aborted) onCallerAbort();
		if (origin?.signal.aborted) onOwnerAbort();
		try {
			const { safeParse } = await interrupted(loadMcpSdkZodCompat(), operation.signal);
			// Use the SDK's own Zod identity, including when npm installs another copy for this package.
			const { ResultSchema } = await interrupted(loadMcpSdkTypes(), operation.signal);
			await resolveAuthority();
			for (let round = 0; ; round++) {
				await resolveAuthority();
				const remaining = deadline - clock.now();
				const attempt = new AbortController();
				const forward = () => attempt.abort("MCP request canceled");
				operation.signal.addEventListener("abort", forward, { once: true });
				const metadata = isRecord(params._meta) ? params._meta : {};
				const capabilities = !presentationLost && origin?.presentation ? { elicitation: {} } : {};
				const outgoing = {
					...params,
					...continuation,
					_meta: { ...metadata, [capabilitiesKey]: capabilities },
					[modernDispatchGuard]: (snapshot?: string) => {
						check();
						if ((snapshot ?? readCredential()) !== credential) throw new McpMrtrError("MCP_MRTR_CONTEXT_CHANGED");
					},
				};
				let result: Record<string, unknown>;
				try {
					check();
					result = await sdkRequest({ method: request.method, params: outgoing }, ResultSchema, {
						...sdkOptions,
						signal: attempt.signal,
						timeout: Math.min(timeout, remaining),
						maxTotalTimeout: remaining,
						onprogress: sdkOptions.onprogress
							? (progress) => {
									check();
									if (
										!Number.isFinite(progress.progress) ||
										(progress.total !== undefined && !Number.isFinite(progress.total))
									)
										return;
									sdkOptions.onprogress?.({
										progress: progress.progress,
										...(progress.total === undefined ? {} : { total: progress.total }),
									});
								}
							: undefined,
					});
				} finally {
					operation.signal.removeEventListener("abort", forward);
				}
				check();
				const type = own(result, "resultType") ? result.resultType : "complete";
				if (type === "complete") {
					if (["requestState", "inputRequests", "inputResponses"].some((key) => own(result, key)))
						throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
					const parsed = safeParse(schema, result);
					if (!parsed.success) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
					return parsed.data;
				}
				if (type !== "input_required" || !capableMethods.has(request.method))
					throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
				const inputs = parseInputs(result);
				if (round >= MAX_MCP_MRTR_ROUNDS) throw new McpMrtrError("MCP_MRTR_ROUND_LIMIT");
				continuation = own(result, "requestState") ? { requestState: result.requestState } : {};
				if (inputs) {
					const responses: Record<string, MrtrInputResponse> = Object.create(null);
					let cancelled = false;
					for (const [key, input] of inputs) {
						await resolveAuthority();
						if (input.params.mode === "url") {
							throw new McpMrtrError("MCP_MRTR_UNSUPPORTED_INPUT");
						} else if (cancelled || consentSpent >= 300_000) {
							// No fabricated results for inputs that were never presented.
							throw new McpMrtrError("MCP_MRTR_CANCELLED");
						} else if (presentationLost || !origin?.presentation) {
							throw new McpMrtrError("MCP_MRTR_UNSUPPORTED_INPUT");
						} else {
							const consent = new AbortController();
							const began = clock.now();
							const consentTimer = clock.schedule(() => consent.abort(), Math.max(0, 300_000 - consentSpent));
							const signal = AbortSignal.any([operation.signal, origin.presentation.signal, consent.signal]);
							let presented = false;
							try {
								const answer = await interrupted(
									queuedForm(origin.binding, signal, () => {
										presented = true;
										return collectMrtrForm(
											origin.presentation as NonNullable<McpRequestOrigin["presentation"]>,
											origin.serverLabel,
											{ message: input.params.message, requestedSchema: input.params.requestedSchema },
											signal,
										);
									}),
									operation.signal,
								);
								check();
								if (!presented) throw new McpMrtrError("MCP_MRTR_CANCELLED");
								responses[key] = answer;
								cancelled = answer.action !== "accept";
							} finally {
								consentSpent += clock.now() - began;
								clock.cancel(consentTimer);
								consent.abort();
							}
						}
					}
					if (byteSize(responses) > 512 * 1024) throw new McpMrtrError("MCP_MRTR_INPUT_LIMIT");
					continuation.inputResponses = responses;
				}
			}
		} catch (error) {
			check();
			if (error instanceof McpMrtrError) throw error;
			if (error instanceof AuthError) throw error;
			const remoteCode = isRecord(error) && typeof error.code === "number" ? error.code : undefined;
			throw new McpMrtrError("MCP_MRTR_TRANSPORT_FAILED", remoteCode);
		} finally {
			continuation = {};
			clock.cancel(timer);
			off?.();
			sdkOptions.signal?.removeEventListener("abort", onCallerAbort);
			origin?.signal.removeEventListener("abort", onOwnerAbort);
			origin?.presentation?.signal.removeEventListener("abort", onPresentationLost);
		}
	};
	// Preserve the SDK method itself until negotiation positively selects modern.
	protocol.activateRequests = () => {
		client.request = requestWithMrtr;
	};
	if (protocol.version !== undefined) protocol.activateRequests();
}

function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onabort = () => reject(signal.reason);
		signal.addEventListener("abort", onabort, { once: true });
		if (signal.aborted) onabort();
		void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onabort));
	});
}
