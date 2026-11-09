/**
 * The request-hook contract of hosted model-key custody (row CK21; custody design 4.9, round-10 fold section 15).
 *
 * `HookRequestInput` is the serializable projection of the fused `before_provider_request` input: the provider payload
 * and the effective request model, without the request headers or the model's own headers, which can carry a
 * credential and never leave the side that dials. A step call has this input; an aux call has none. A hand serves
 * `hook.model_request` by running its user's request hooks on the input, only after the request's placement claim
 * verified, and replies with the payload they produced.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExecutionScope } from "@earendil-works/pi-agent-core";
import { CLAIM_VERDICT_ERRORS, type ClaimVerdict } from "../egress/placement-claim.ts";
import type {
	HookModelRequest,
	HookModelRequestReply,
	ProviderCallErrorCode,
	ProviderCallKind,
	WireJson,
} from "../egress/wire.ts";
import type { BeforeProviderRequestEvent } from "../extensions/types.ts";

/** The pinned shape of `HookModelRequestInput` (and of the reply's `output`). */
export type HookRequestInput = { readonly payload: WireJson; readonly model?: { readonly [key: string]: WireJson } };

/** The input or output cannot cross the wire: it is not JSON, or not the closed envelope. */
export class HookContractError extends Error {
	override readonly name = "HookContractError";
}

/** The request's placement claim did not verify, so no hook ran; `code`/`retryable` are the claim's wire answer. */
export class HookRequestRefusedError extends Error {
	override readonly name = "HookRequestRefusedError";
	readonly verdict: Exclude<ClaimVerdict, "valid">;
	readonly code: ProviderCallErrorCode;
	readonly retryable: boolean;
	constructor(verdict: Exclude<ClaimVerdict, "valid">) {
		super(`hook.model_request refused: placement claim ${verdict}`);
		this.verdict = verdict;
		this.code = CLAIM_VERDICT_ERRORS[verdict].code;
		this.retryable = CLAIM_VERDICT_ERRORS[verdict].retryable;
	}
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

/** `value` as JSON, exactly; anything JSON would drop, coerce or reject is refused (an `undefined` member is absent). */
function wireJson(value: unknown, at: string): WireJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new HookContractError(`${at} is not a finite number`);
	}
	if (Array.isArray(value)) return value.map((item, index) => wireJson(item, `${at}[${index}]`));
	if (isPlainObject(value)) {
		const out: Record<string, WireJson> = {};
		for (const [key, member] of Object.entries(value))
			if (member !== undefined) out[key] = wireJson(member, `${at}.${key}`);
		return out;
	}
	throw new HookContractError(`${at} is not JSON`);
}

function wireModel(model: Model<Api>): { readonly [key: string]: WireJson } {
	const { headers: _headers, ...rest } = model;
	return wireJson(rest, "model") as { readonly [key: string]: WireJson };
}

/** The projection of a fused `before_provider_request` input. */
export function hookRequestInputOf(
	event: Omit<BeforeProviderRequestEvent, "type"> & { type?: string },
): HookRequestInput {
	const payload = wireJson(event.payload, "payload");
	return event.model === undefined ? { payload } : { payload, model: wireModel(event.model) };
}

/** A step call's hook input; an aux call runs no request hooks on the hand and has none. */
export function hookRequestInputForCall(
	call: ProviderCallKind,
	event: Omit<BeforeProviderRequestEvent, "type"> & { type?: string },
): HookRequestInput | undefined {
	return call.kind === "step" ? hookRequestInputOf(event) : undefined;
}

/** The reply's `output`: the payload the hooks produced, with the model the request carried. */
export function hookRequestOutputOf(input: HookRequestInput, payload: unknown): HookRequestInput {
	const out = wireJson(payload, "payload");
	return input.model === undefined ? { payload: out } : { payload: out, model: input.model };
}

const MODEL_STRING_FIELDS = ["id", "name", "api", "provider", "baseUrl"] as const;

/** Reads a wire value back as the closed envelope `{ payload, model? }`; the model never carries headers. */
export function parseHookRequestInput(value: unknown): HookRequestInput {
	if (!isPlainObject(value) || !("payload" in value))
		throw new HookContractError("hook input is not an object with a payload");
	const extra = Object.keys(value).filter((key) => key !== "payload" && key !== "model");
	if (extra.length > 0) throw new HookContractError(`hook input has unknown members: ${extra.join(", ")}`);
	const payload = wireJson(value.payload, "payload");
	if (value.model === undefined) return { payload };
	const model = value.model;
	if (!isPlainObject(model) || MODEL_STRING_FIELDS.some((field) => typeof model[field] !== "string"))
		throw new HookContractError("hook input model is not a model");
	if ("headers" in model) throw new HookContractError("hook input model carries headers");
	return { payload, model: wireJson(model, "model") as { readonly [key: string]: WireJson } };
}

/** The effective model a hand hands its hooks, as the loop sent it. */
export function hookModelOf(input: HookRequestInput): Model<Api> | undefined {
	return input.model as Model<Api> | undefined;
}

export interface HookServePorts {
	/** The hand's placement-claim check (CK7's verifier with the hand's trust and clock). */
	verifyClaim(claim: unknown): Promise<ClaimVerdict>;
	/** Runs the user's request hooks of `sessionId` on `input` and returns their output. */
	runRequestHooks(sessionId: string, input: HookRequestInput): Promise<HookRequestInput>;
}

/** Serves one `hook.model_request`: claim first, then the closed input, then the hooks. */
export async function serveHookModelRequest(
	request: HookModelRequest,
	ports: HookServePorts,
): Promise<HookModelRequestReply> {
	const verdict = await ports.verifyClaim(request.claim);
	if (verdict !== "valid") throw new HookRequestRefusedError(verdict);
	const input = parseHookRequestInput(request.input);
	const output = await ports.runRequestHooks(request.sessionId, input);
	return { t: "hook.model_request.reply", sessionId: request.sessionId, stepId: request.stepId, output };
}

/**
 * `runRequestHooks` over a hand's loop-hook runner (`LooplessHand.loopHooks`): the session's hooks run on the runtime of
 * `scope`, inside a loop-hook call bound to that session, with the loop busy (a model request is mid-turn).
 */
export function loopHookRequestHooks(
	loopHooks: (event: string, payload: WireJson) => Promise<unknown>,
	scope: ExecutionScope,
): HookServePorts["runRequestHooks"] {
	return async (sessionId, input) => {
		const reply = await loopHooks("before_provider_request", {
			scope: { id: scope.id, root: scope.root },
			sessionId,
			idle: false,
			input,
		});
		if (!isPlainObject(reply)) throw new HookContractError("the hand's request-hook reply is not an object");
		return parseHookRequestInput(reply.output);
	};
}
