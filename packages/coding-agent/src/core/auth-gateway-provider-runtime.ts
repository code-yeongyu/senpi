import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AuthBrokerRemoteStore } from "./auth-broker-remote-store.ts";
import type { AuthBrokerCredentialSelector } from "./auth-broker-wire-contract.ts";

type BrokerOutcome = "success" | "rate_limited" | "unauthorized" | "unavailable";

export type AuthGatewayProviderRequestSettings = {
	readonly env?: Readonly<Record<string, string>>;
	readonly extraBody?: Readonly<Record<string, unknown>>;
	readonly headers?: Readonly<Record<string, string | null>>;
	readonly maxRetries?: number;
	readonly maxRetryDelayMs?: number;
	readonly timeoutMs?: number;
	readonly upstreamModelId?: string;
	readonly websocketConnectTimeoutMs?: number;
};

export type AuthGatewayProviderRuntimeCall = {
	readonly context: Context;
	readonly modelId: string;
	readonly provider: string;
	readonly selector?: AuthBrokerCredentialSelector;
	readonly signal?: AbortSignal;
	readonly streamOptions?: Omit<SimpleStreamOptions, "apiKey" | "env" | "extraBody" | "headers" | "signal">;
};

export type AuthGatewayProviderRuntimeResult =
	| { readonly kind: "aborted"; readonly statusCode: 499 }
	| { readonly kind: "model_not_found"; readonly statusCode: 404 }
	| { readonly kind: "overloaded"; readonly statusCode: 503 }
	| {
			readonly kind: "stream";
			readonly leaseId: string;
			readonly model: Model<Api>;
			readonly stream: AssistantMessageEventStream;
	  };

export type AuthGatewayProviderRuntimeOptions = {
	readonly broker: AuthBrokerRemoteStore;
	readonly maxConcurrentCalls?: number;
	readonly resolveModel: (provider: string, modelId: string) => Model<Api> | undefined;
	readonly resolveRequest?: (model: Model<Api>) => AuthGatewayProviderRequestSettings;
	readonly streamSimple?: (
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
	) => AssistantMessageEventStream;
};

export interface AuthGatewayProviderRuntime {
	stream(call: AuthGatewayProviderRuntimeCall): Promise<AuthGatewayProviderRuntimeResult>;
	close(): void;
}

export function createAuthGatewayProviderRuntime(
	options: AuthGatewayProviderRuntimeOptions,
): AuthGatewayProviderRuntime {
	return new GatewayProviderRuntime(options);
}

class GatewayProviderRuntime implements AuthGatewayProviderRuntime {
	private readonly activeControllers = new Set<AbortController>();
	private readonly broker: AuthBrokerRemoteStore;
	private readonly maxConcurrentCalls: number;
	private readonly resolveModel: AuthGatewayProviderRuntimeOptions["resolveModel"];
	private readonly resolveRequest: AuthGatewayProviderRuntimeOptions["resolveRequest"];
	private readonly streamProvider: NonNullable<AuthGatewayProviderRuntimeOptions["streamSimple"]>;
	private closed = false;

	constructor(options: AuthGatewayProviderRuntimeOptions) {
		if (!Number.isInteger(options.maxConcurrentCalls ?? 64) || (options.maxConcurrentCalls ?? 64) < 1) {
			throw new AuthGatewayProviderRuntimeError("maxConcurrentCalls must be a positive integer");
		}
		this.broker = options.broker;
		this.maxConcurrentCalls = options.maxConcurrentCalls ?? 64;
		this.resolveModel = options.resolveModel;
		this.resolveRequest = options.resolveRequest;
		this.streamProvider = options.streamSimple ?? streamSimple;
	}

	async stream(call: AuthGatewayProviderRuntimeCall): Promise<AuthGatewayProviderRuntimeResult> {
		if (this.closed || this.activeControllers.size >= this.maxConcurrentCalls) {
			return { kind: "overloaded", statusCode: 503 };
		}
		if (call.signal?.aborted) return { kind: "aborted", statusCode: 499 };
		const model = this.resolveModel(call.provider, call.modelId);
		if (model === undefined) return { kind: "model_not_found", statusCode: 404 };
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		call.signal?.addEventListener("abort", abort, { once: true });
		this.activeControllers.add(controller);
		let leaseId: string | undefined;
		try {
			const pool = await this.poolFor(call.provider, controller.signal);
			if (controller.signal.aborted) {
				this.release(controller, call.signal, abort);
				return { kind: "aborted", statusCode: 499 };
			}
			const lease = await this.broker.select(
				pool,
				call.selector ?? { kind: "automatic" },
				call.streamOptions?.sessionId,
			);
			leaseId = lease.leaseId;
			if (controller.signal.aborted) {
				await this.report(lease.leaseId, "unavailable");
				this.release(controller, call.signal, abort);
				return { kind: "aborted", statusCode: 499 };
			}
			const request = this.resolveRequest?.(model);
			const requestModel =
				request?.upstreamModelId === undefined ? model : { ...model, id: request.upstreamModelId };
			const stream = this.streamProvider(requestModel, call.context, {
				...call.streamOptions,
				apiKey: credentialSecret(lease.material),
				env: request?.env === undefined ? undefined : { ...request.env },
				extraBody: request?.extraBody === undefined ? undefined : { ...request.extraBody },
				headers: request?.headers === undefined ? undefined : { ...request.headers },
				maxRetries: request?.maxRetries,
				maxRetryDelayMs: request?.maxRetryDelayMs,
				signal: controller.signal,
				timeoutMs: request?.timeoutMs,
				websocketConnectTimeoutMs: request?.websocketConnectTimeoutMs,
			});
			this.track(stream, lease.leaseId, controller, call.signal, abort);
			return { kind: "stream", leaseId: lease.leaseId, model: requestModel, stream };
		} catch (error) {
			if (leaseId !== undefined) await this.report(leaseId, "unavailable");
			this.release(controller, call.signal, abort);
			if (controller.signal.aborted) return { kind: "aborted", statusCode: 499 };
			throw error;
		}
	}

	close(): void {
		this.closed = true;
		for (const controller of this.activeControllers) controller.abort();
	}

	private async poolFor(
		provider: string,
		signal: AbortSignal,
	): Promise<{ readonly provider: string; readonly type: "api_key" | "oauth" }> {
		const snapshot = await this.broker.metadataSnapshot();
		if (signal.aborted) throw new GatewayProviderRuntimeAbortedError();
		const credential = snapshot.credentials.find(
			(candidate) => candidate.pool.provider === provider && candidate.disabled === undefined,
		);
		if (credential === undefined)
			throw new AuthGatewayProviderRuntimeError("No eligible broker credential is available");
		return credential.pool;
	}

	private track(
		stream: AssistantMessageEventStream,
		leaseId: string,
		controller: AbortController,
		callerSignal: AbortSignal | undefined,
		abort: () => void,
	): void {
		void this.finish(stream, leaseId, controller, callerSignal, abort);
	}

	private async finish(
		stream: AssistantMessageEventStream,
		leaseId: string,
		controller: AbortController,
		callerSignal: AbortSignal | undefined,
		abort: () => void,
	): Promise<void> {
		try {
			const message = await stream.result();
			await this.report(leaseId, classifyOutcome(message));
		} catch {
			await this.report(leaseId, "unavailable");
		} finally {
			this.release(controller, callerSignal, abort);
		}
	}

	private async report(leaseId: string, status: BrokerOutcome): Promise<void> {
		try {
			await this.broker.reportOutcome(leaseId, status, new Date().toISOString());
		} catch {
			return;
		}
	}

	private release(controller: AbortController, callerSignal: AbortSignal | undefined, abort: () => void): void {
		callerSignal?.removeEventListener("abort", abort);
		this.activeControllers.delete(controller);
	}
}

export class AuthGatewayProviderRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthGatewayProviderRuntimeError";
	}
}

class GatewayProviderRuntimeAbortedError extends Error {}

function credentialSecret(
	material:
		| { readonly apiKey: string; readonly type: "api_key" }
		| { readonly accessToken: string; readonly type: "oauth" },
): string {
	return material.type === "api_key" ? material.apiKey : material.accessToken;
}

function classifyOutcome(message: AssistantMessage): BrokerOutcome {
	if (message.stopReason !== "error") return message.stopReason === "aborted" ? "unavailable" : "success";
	const detail = message.errorMessage ?? "";
	if (/\b(?:401|unauthori[sz]ed)\b/i.test(detail)) return "unauthorized";
	if (/\b(?:429|rate[ -]?limit)\b/i.test(detail)) return "rate_limited";
	return "unavailable";
}
