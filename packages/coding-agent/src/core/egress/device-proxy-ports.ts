/**
 * The ports the device route of hosted model-key custody runs on (row CK9; custody design 2.3, 4.2-4.6): the hands'
 * channels and presence, the session's route inputs, the placement claim, the request-hook runner, the wait sources
 * and the loop's bounds. The hosted wrapper (V7b) supplies them; tests supply doubles.
 */
import type {
	DeviceId,
	EgressHostHooks,
	EgressRouteDecision,
	ProviderId,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import type { DeviceRouteBounds } from "./device-proxy-call.ts";
import type { RequestHookRunner } from "./device-proxy-request.ts";
import type { EgressClock, WaitConditionSource } from "./device-proxy-waits.ts";
import type { EgressLedger } from "./ledger.ts";
import type { EgressCallCapability, VariantRecord } from "./ledger-schema.ts";
import type { SignedPlacementClaim } from "./placement-claim.ts";
import type { ProviderCallChannel, StepNotice } from "./wire.ts";

export interface DeviceHands {
	channel(deviceId: DeviceId): ProviderCallChannel;
	/** How long the device has been continuously offline (0 while online); compared with the resume window (4.4). */
	offlineFor(deviceId: DeviceId): number;
}

/** The session's route inputs (route.ts `decideRoute` over presence, roster, hooks and variants; CK6/CK25). */
export interface DeviceRouteSource {
	decide(providerId: ProviderId, variants: ReadonlyMap<DeviceId, VariantRecord>): EgressRouteDecision;
	/** The head entry's `sourceDigest`, sent as `expectedSourceDigest` unless the hand serves its own definition. */
	headDigest(providerId: ProviderId): string | undefined;
	capability(providerId: ProviderId): EgressCallCapability;
	liveDigest(deviceId: DeviceId, providerId: ProviderId): string | undefined;
}

export interface PlacementClaimSource {
	current(): Promise<SignedPlacementClaim>;
	/** Re-claims (same epoch on expiry; under the new registry generation on `registry_key_revoked`). */
	renew(code: "claim_expired" | "registry_key_revoked"): Promise<void>;
}

export interface DeviceProxyEgressDeps {
	readonly sessionId: string;
	readonly host: EgressHostHooks;
	readonly ledger: EgressLedger;
	readonly hands: DeviceHands;
	readonly route: DeviceRouteSource;
	readonly claims: PlacementClaimSource;
	readonly requestHooks: RequestHookRunner;
	readonly conditions: WaitConditionSource;
	readonly notify: (notice: StepNotice) => void;
	readonly clock: EgressClock;
	readonly bounds: DeviceRouteBounds;
	readonly cwd?: string;
}

export interface DeviceProxyEgress {
	readonly stream: StreamFn;
}
