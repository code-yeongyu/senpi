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
/** At most one minute of churn waiting per step; past it the step reports a config-churn wait. */
const STABLE_HEAD_ATTEMPTS = 12;
const REDACTED = "<redacted>";

const RETRYABLE: readonly ReleaseFailure[] = [
	"stale_snapshot",
	"epoch_mismatch",
	"unresolved_field",
	"wrap_missing",
	"unavailable",
] as const;

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
	readonly sleep: (ms: number) => Promise<void>;
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
		for (let attempt = 0; attempt < 2; attempt++) {
			const generation = this.#generation;
			const values = await this.#resolveValues(providerId, entryDigest, fields, scope);
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

	async #resolveValues(
		providerId: ProviderId,
		entryDigest: string,
		fields: readonly SecretField[],
		scope: ReleaseScope,
	): Promise<Map<SecretField, Uint8Array>> {
		let digest = entryDigest;
		let reloads = 0;
		let churnRetried = false;
		for (;;) {
			const lease = await this.#deps.lease();
			const result = await this.#release(providerId, digest, fields, scope, lease);
			if (result.ok) return this.#open(providerId, digest, fields, result.items, lease);
			if (result.code !== "stale_snapshot") throw new CredentialWait(result.code, RETRYABLE.includes(result.code));
			if (reloads < RELOADS_PER_STEP) {
				reloads++;
				digest = await this.#deps.reloadEntryDigest(providerId);
				continue;
			}
			if (churnRetried || !(await this.#waitForStableHead())) throw new CredentialWait("config-churn", true);
			churnRetried = true;
			digest = await this.#deps.reloadEntryDigest(providerId);
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

	/** True once the head held still for STABLE_HEAD_MS; false when it never settled within the bound. */
	async #waitForStableHead(): Promise<boolean> {
		let previous = await this.#deps.readHead();
		for (let attempt = 0; attempt < STABLE_HEAD_ATTEMPTS; attempt++) {
			await this.#deps.sleep(STABLE_HEAD_MS);
			const current = await this.#deps.readHead();
			if (current === previous) return true;
			previous = current;
		}
		return false;
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
