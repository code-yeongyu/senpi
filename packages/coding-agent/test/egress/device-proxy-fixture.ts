/**
 * The device-proxy egress wired to the doubles (CK9 tests): hand doubles that verify real signed placement claims from
 * the CK7 fixture, a route double, a faux model as the hand's provider, and request hooks that tag the request.
 */
import { type DeviceId, type EgressRouteDecision } from "@earendil-works/pi-agent-core";
import type { DurableStore } from "@earendil-works/pi-agent-core/conformance";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
	normalizeContext,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { createDeviceProxyEgress } from "../../src/core/egress/device-proxy.ts";
import type { DeviceProxyEgress } from "../../src/core/egress/device-proxy-ports.ts";
import type { EgressLedger } from "../../src/core/egress/ledger.ts";
import type { EgressCallCapability, VariantRecord } from "../../src/core/egress/ledger-schema.ts";
import type { PlacementClaim, SignedPlacementClaim } from "../../src/core/egress/placement-claim.ts";
import type { ProviderCallRequest, StepNotice } from "../../src/core/egress/wire.ts";
import { AT, claimFields, signClaim, trusted } from "./claim-fixture.ts";
import { createHandDouble, type HandDouble, type Responder } from "./device-hand-double.ts";
import {
	type CommitWatch,
	type ConditionsDouble,
	commitWatch,
	conditionsDouble,
	type HostDouble,
	hostDouble,
	ledgerOn,
	type ManualClock,
	manualClock,
	SESSION,
} from "./device-proxy-doubles.ts";

export const PROVIDER = "faux";

export interface RouteDouble {
	decision: (variants: ReadonlyMap<DeviceId, VariantRecord>) => EgressRouteDecision;
	headDigest: string | undefined;
	capability: EgressCallCapability;
	live: Map<string, string>;
}

export const handRoute = (deviceId = "laptop"): EgressRouteDecision => ({
	route: "device",
	reason: "custody:device",
	deviceId,
	servedNow: true,
	executorHooks: "enabled",
});

export const serverRoute = (deviceId: string, requestHooksOn?: string): EgressRouteDecision => ({
	route: "device",
	reason: "custody:device",
	deviceId,
	servedNow: true,
	executorHooks: "disabled",
	...(requestHooksOn ? { requestHooksOn } : {}),
});

export function fauxModel(): {
	readonly model: Model<string>;
	readonly respond: Responder;
	readonly reply: (text: string) => void;
	readonly replyMessage: (message: AssistantMessage) => void;
} {
	const faux = registerFauxProvider({ api: `faux-${crypto.randomUUID()}`, provider: PROVIDER });
	const model = faux.getModel();
	const respond: Responder = async (_start, request) => {
		if (!("context" in request)) throw new Error("the device route carries a context request");
		const events: AssistantMessageEvent[] = [];
		for await (const event of streamSimple(model, request.context, request.options)) events.push(event);
		return events;
	};
	return {
		model,
		respond,
		reply: (text) => faux.appendResponses([fauxAssistantMessage(text)]),
		replyMessage: (message) => faux.appendResponses([message]),
	};
}

export interface EgressRig {
	readonly egress: DeviceProxyEgress;
	readonly ledger: EgressLedger;
	readonly hands: Map<string, HandDouble>;
	readonly host: HostDouble;
	readonly conditions: ConditionsDouble;
	readonly clock: ManualClock;
	readonly route: RouteDouble;
	readonly notices: StepNotice[];
	readonly hookRequests: Array<{ readonly hand: string; readonly request: ProviderCallRequest }>;
	readonly offline: Map<string, number>;
	readonly claimRenewals: string[];
	readonly commits: CommitWatch;
	claimSource(): Promise<SignedPlacementClaim>;
}

export interface RigOptions {
	readonly store: DurableStore;
	readonly respond: Responder;
	readonly devices?: readonly string[];
	readonly host?: HostDouble;
	readonly requestHook?: (request: ProviderCallRequest) => ProviderCallRequest;
	readonly claimOverrides?: Partial<PlacementClaim>;
	readonly hands?: Map<string, HandDouble>;
}

export const transcript = (text = "hi"): TranscriptContext =>
	normalizeContext({ systemPrompt: "you are a test", messages: [{ role: "user", content: text, timestamp: 1 }] });

/** The session's request hook in these tests: it appends a marker message the stored request must then carry. */
export const tagRequest = (request: ProviderCallRequest): ProviderCallRequest =>
	"context" in request
		? {
				...request,
				context: {
					...request.context,
					messages: [...request.context.messages, { role: "user", content: "[hooked]", timestamp: 2 }],
				},
			}
		: request;

export async function rig(options: RigOptions): Promise<EgressRig> {
	const fresh = await trusted();
	const shared = options.hands?.values().next().value;
	const reg = shared?.registry ?? fresh.reg;
	const trust = fresh.trust;
	const valid = await signClaim(claimFields(options.claimOverrides), reg);
	let claim = valid;
	const hands =
		options.hands ??
		new Map(
			(options.devices ?? ["laptop"]).map((deviceId) => [
				deviceId,
				createHandDouble({
					deviceId,
					registry: reg,
					trust,
					clock: AT,
					respond: options.respond,
					...(options.requestHook ? { requestHook: options.requestHook } : {}),
				}),
			]),
		);
	const host = options.host ?? hostDouble();
	const conditions = conditionsDouble();
	const clock = manualClock();
	const route: RouteDouble = {
		decision: () => handRoute(),
		headDigest: "digest-head",
		capability: "stream",
		live: new Map(),
	};
	const notices: StepNotice[] = [];
	const hookRequests: EgressRig["hookRequests"] = [];
	const offline = new Map<string, number>();
	const claimRenewals: string[] = [];
	const commits = commitWatch();
	const ledger = ledgerOn(options.store, commits);
	const egress = createDeviceProxyEgress({
		sessionId: SESSION,
		host,
		ledger,
		hands: {
			channel: (deviceId) => {
				const hand = hands.get(deviceId);
				if (!hand) throw new Error(`no hand ${deviceId}`);
				return hand;
			},
			offlineFor: (deviceId) => offline.get(deviceId) ?? 0,
		},
		route: {
			decide: (_providerId, variants) => route.decision(variants),
			headDigest: () => route.headDigest,
			capability: () => route.capability,
			liveDigest: (deviceId) => route.live.get(deviceId),
		},
		claims: {
			current: async () => claim,
			renew: async (code) => {
				claimRenewals.push(code);
				claim = await signClaim(claimFields(), reg);
			},
		},
		requestHooks: async (hand, request) => {
			hookRequests.push({ hand, request });
			return (options.requestHook ?? tagRequest)(request);
		},
		conditions,
		notify: (notice) => notices.push(notice),
		clock,
		bounds: { idleMs: 60_000, resumeWindowMs: 5_000, deadlineMs: 600_000 },
	});
	return {
		egress,
		ledger,
		hands,
		host,
		conditions,
		clock,
		route,
		notices,
		hookRequests,
		offline,
		claimRenewals,
		commits,
		claimSource: async () => claim,
	};
}

export function handOf(r: EgressRig, deviceId = "laptop"): HandDouble {
	const hand = r.hands.get(deviceId);
	if (!hand) throw new Error(`no hand ${deviceId}`);
	return hand;
}
