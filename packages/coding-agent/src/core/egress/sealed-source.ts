import {
	type CredentialSource,
	CredentialWait,
	type EpochLeaseToken,
	type ReleaseFailure,
	type ReleaseResult,
	type ReleaseScope,
	type SecretField,
	type SecretLease,
	SecretNotLeased,
	type Unsealer,
} from "./credentials.ts";
import type { HpkeWrap, ProviderId } from "./sealed-format.ts";

const RELOADS_PER_STEP = 3;
const STABLE_HEAD_MS = 5000;
const REDACTED = "<redacted>";

const RETRYABLE = [
	"stale_snapshot",
	"epoch_mismatch",
	"unresolved_field",
	"wrap_missing",
	"unavailable",
] as const satisfies readonly ReleaseFailure[];

interface StepState {
	digest: string;
	reloads: number;
	noticed: boolean;
}

export interface ReleasedItemPosition {
	readonly accountId: string;
	readonly providerId: ProviderId;
	readonly entryDigest: string;
	readonly field: SecretField;
	/** The lease this release was made under: the opener rebuilds epoch and placementId from it (r11.2 C.5). */
	readonly lease: EpochLeaseToken;
}

export interface SealedSourceDeps {
	readonly accountId: string;
	readonly unsealer: Unsealer;
	readonly lease: () => Promise<EpochLeaseToken>;
	readonly recipientPk: Uint8Array;
	readonly reloadEntryDigest: (providerId: ProviderId) => Promise<string>;
	readonly readHead: () => Promise<string>;
	/** Rejects with the signal's reason once the step aborts. */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** The abort signal of the step this release serves; it bounds the churn wait (custody design L844, C.3). */
	readonly stepSignal: (scope: ReleaseScope) => AbortSignal;
	/** Called once per step when the step enters the config-churn wait (C.3), so the caller can show one notice. */
	readonly onChurnNotice: (scope: ReleaseScope) => void;
	/** Opens one released item with this instance's recipient key; its HPKE info/AAD binding is fixed by r11.1. */
	readonly openItem: (item: HpkeWrap, position: ReleasedItemPosition) => Promise<Uint8Array>;
}

class SealedLease implements SecretLease {
	#values: Map<SecretField, Uint8Array> | undefined;
	readonly #onDispose: (lease: SealedLease) => void;

	constructor(values: Map<SecretField, Uint8Array>, onDispose: (lease: SealedLease) => void) {
		this.#values = values;
		this.#onDispose = onDispose;
	}

	value(field: SecretField): string {
		const bytes = this.#values?.get(field);
		if (bytes === undefined) throw new SecretNotLeased(field);
		return new TextDecoder().decode(bytes);
	}

	[Symbol.dispose](): void {
		const values = this.#values;
		if (values === undefined) return;
		this.#values = undefined;
		for (const bytes of values.values()) bytes.fill(0);
		this.#onDispose(this);
	}

	toJSON(): string {
		return REDACTED;
	}

	toString(): string {
		return REDACTED;
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return REDACTED;
	}
}

/** Per egress instance (custody design 3.4): its leases live on the instance, never in module scope. */
export class SealedCredentialSource implements CredentialSource {
	readonly #deps: SealedSourceDeps;
	readonly #live = new Set<SealedLease>();
	#generation = 0;

	constructor(deps: SealedSourceDeps) {
		this.#deps = deps;
	}

	async resolve(
		providerId: ProviderId,
		entryDigest: string,
		fields: readonly SecretField[],
		scope: ReleaseScope,
	): Promise<SecretLease> {
		if (new Set(fields).size !== fields.length) throw new TypeError("a sealed release names each field at most once");
		const step: StepState = { digest: entryDigest, reloads: 0, noticed: false };
		for (let attempt = 0; attempt < 2; attempt++) {
			const generation = this.#generation;
			const values = await this.#resolveValues(providerId, step, fields, scope);
			if (generation === this.#generation) {
				const lease = new SealedLease(values, (disposed) => this.#live.delete(disposed));
				this.#live.add(lease);
				return lease;
			}
			for (const bytes of values.values()) bytes.fill(0);
		}
		throw new CredentialWait("config-churn", true);
	}

	/** Disposes every live lease, and voids any lease still being resolved when the bump lands. */
	bumpGeneration(): void {
		this.#generation++;
		for (const lease of [...this.#live]) lease[Symbol.dispose]();
	}

	/** One release attempt; `step` carries the reload count, notice latch and digest across bump retries (C.3). */
	async #resolveValues(
		providerId: ProviderId,
		step: StepState,
		fields: readonly SecretField[],
		scope: ReleaseScope,
	): Promise<Map<SecretField, Uint8Array>> {
		const signal = this.#deps.stepSignal(scope);
		for (;;) {
			signal.throwIfAborted();
			const lease = await this.#deps.lease();
			const result = await this.#release(providerId, step.digest, fields, scope, lease);
			if (result.ok) return this.#open(providerId, step.digest, fields, result.items, lease);
			if (result.code !== "stale_snapshot")
				throw new CredentialWait(
					result.code,
					RETRYABLE.some((code) => code === result.code),
				);
			if (step.reloads < RELOADS_PER_STEP) {
				step.reloads++;
			} else {
				// config-churn (C.3): every further stale retry re-enters the stable-head wait, never the immediate reloads.
				if (!step.noticed) {
					step.noticed = true;
					this.#deps.onChurnNotice(scope);
				}
				await this.#waitForStableHead(signal);
			}
			step.digest = await this.#deps.reloadEntryDigest(providerId);
		}
	}

	async #release(
		providerId: ProviderId,
		entryDigest: string,
		fields: readonly SecretField[],
		scope: ReleaseScope,
		lease: EpochLeaseToken,
	): Promise<ReleaseResult> {
		return this.#deps.unsealer.release({
			accountId: this.#deps.accountId,
			providerId,
			entryDigest,
			fields,
			lease,
			recipientPk: this.#deps.recipientPk,
			scope,
		});
	}

	/** Returns once the head held still for STABLE_HEAD_MS; rejects when the step aborts first. */
	async #waitForStableHead(signal: AbortSignal): Promise<void> {
		let previous = await this.#deps.readHead();
		for (;;) {
			await this.#deps.sleep(STABLE_HEAD_MS, signal);
			const current = await this.#deps.readHead();
			if (current === previous) return;
			previous = current;
		}
	}

	async #open(
		providerId: ProviderId,
		entryDigest: string,
		fields: readonly SecretField[],
		items: readonly HpkeWrap[],
		epochLease: EpochLeaseToken,
	): Promise<Map<SecretField, Uint8Array>> {
		if (items.length !== fields.length) throw new CredentialWait("denied", false);
		const values = new Map<SecretField, Uint8Array>();
		try {
			for (const [index, field] of fields.entries()) {
				const position = { accountId: this.#deps.accountId, providerId, entryDigest, field, lease: epochLease };
				values.set(field, await this.#deps.openItem(items[index], position));
			}
		} catch (error) {
			for (const bytes of values.values()) bytes.fill(0);
			throw error;
		}
		return values;
	}
}
