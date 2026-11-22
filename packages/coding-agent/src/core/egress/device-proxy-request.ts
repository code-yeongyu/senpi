/**
 * What the device route sends (row CK9; custody design 2.3 options hygiene, 4.5 hook rules). The admitted request is
 * built once from the loop's context and the wire allowlist of its options, stored as JSON text, and every attempt
 * sends the parse of that stored text, so a reissue is byte-for-byte the admitted request. Request hooks run once per
 * step: on the hand itself (`hooks: "enabled"`, reported back by `hooked`), or over V5 before a non-hand server. Hook
 * output is filtered through the same allowlist before it is stored, and every parse filters again: a hook that adds
 * `env` or `headers` must not reach another device, where `env` can move the dial under that device's credential.
 */
import type { DeviceId, EgressRouteDecision } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { type ProviderCallRequest, WIRE_STREAM_OPTION_KEYS, type WireStreamOptions } from "./wire.ts";

type MutableWireOptions = { -readonly [K in keyof WireStreamOptions]?: WireStreamOptions[K] };

function copyWireKey<K extends keyof WireStreamOptions>(from: WireStreamOptions, to: MutableWireOptions, key: K): void {
	const value = from[key];
	if (value !== undefined) to[key] = value;
}

/** Only allowlisted, serializable request shaping crosses to the hand: never `commitStep`, secrets, headers or callbacks. */
function toWireOptions(options: WireStreamOptions | undefined): WireStreamOptions {
	const wire: MutableWireOptions = {};
	if (options) for (const key of WIRE_STREAM_OPTION_KEYS) copyWireKey(options, wire, key);
	return wire;
}

export const admittedRequestJson = (context: TranscriptContext, options: SimpleStreamOptions | undefined): string =>
	JSON.stringify({ context, options: toWireOptions(options) });

const isRequest = (value: unknown): value is ProviderCallRequest =>
	typeof value === "object" &&
	value !== null &&
	(("context" in value && "options" in value) || "compactBody" in value);

const toWireRequest = (request: ProviderCallRequest): ProviderCallRequest =>
	"context" in request
		? { context: request.context, options: toWireOptions(request.options) }
		: { compactBody: request.compactBody };

/** The JSON text the ledger stores for a request that came back from a hook (`hooked`, V5). */
export const storedRequestJson = (request: ProviderCallRequest): string => JSON.stringify(toWireRequest(request));

export function parseStoredRequest(json: string): ProviderCallRequest {
	const parsed: unknown = JSON.parse(json);
	if (!isRequest(parsed)) throw new Error("stored egress request is not a provider-call request");
	return toWireRequest(parsed);
}

export interface StoredRequest {
	readonly requestJson: string;
	readonly hooksApplied: boolean;
}

export interface DispatchPlan extends StoredRequest {
	readonly hooks: "enabled" | "disabled";
}

export type RequestHookRunner = (hand: DeviceId, request: ProviderCallRequest) => Promise<ProviderCallRequest>;

/**
 * The hook rules of 4.5: to the hand, `hooks` is `enabled` exactly when the stored request does not carry them yet;
 * to any other server, a request-hooked provider without applied hooks runs them on the hand first and stores the
 * post-hook request with `hooksApplied: true`; everything else goes with `hooks: "disabled"`.
 */
export async function planDispatch(
	decision: EgressRouteDecision,
	stored: StoredRequest,
	runRequestHooks: RequestHookRunner,
): Promise<DispatchPlan> {
	if (decision.executorHooks === "enabled") return { ...stored, hooks: stored.hooksApplied ? "disabled" : "enabled" };
	if (!stored.hooksApplied && decision.requestHooksOn !== undefined) {
		const hooked = await runRequestHooks(decision.requestHooksOn, parseStoredRequest(stored.requestJson));
		return { requestJson: storedRequestJson(hooked), hooksApplied: true, hooks: "disabled" };
	}
	return { ...stored, hooks: "disabled" };
}

/** A fresh object per message: `Usage` is mutable and consumers update it in place. */
const noUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** The terminal message the loop receives when the hand refused or failed the call, or the step was aborted. */
export function failureMessage(
	model: Model<Api>,
	stopReason: "error" | "aborted",
	errorMessage: string,
	usage: Usage = noUsage(),
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

export const ABORT_TEXT = "Request was aborted";
export const idleTimeoutText = (idleMs: number): string => `Idle timeout waiting for provider stream after ${idleMs}ms`;
