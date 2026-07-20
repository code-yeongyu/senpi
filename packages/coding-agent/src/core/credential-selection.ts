import type {
	CredentialPool,
	CredentialPoolKey,
	CredentialRecord,
	CredentialSelector,
	UsageReport,
} from "./auth-multi-account.ts";
import { credentialPoolKey } from "./auth-multi-account.ts";

const RATE_LIMIT_COOLDOWN_MS = 30_000;
const UNAUTHORIZED_COOLDOWN_MS = 300_000;
const UNAVAILABLE_COOLDOWN_MS = 10_000;

export type PooledCredentialSelectionRequest = {
	readonly pool: CredentialPool;
	readonly selector: CredentialSelector;
	readonly sessionId?: string;
};

export class PooledCredentialSelector {
	private readonly cooldowns = new Map<string, number>();
	private readonly remainingFractions = new Map<string, number>();
	private readonly refreshes = new Map<string, Promise<unknown>>();
	private readonly roundRobinCursors = new Map<CredentialPoolKey, number>();
	private readonly sessionAffinities = new Map<string, string>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	select(records: readonly CredentialRecord[], request: PooledCredentialSelectionRequest): CredentialRecord {
		const candidates = records.filter(
			(record) => this.matchesPool(record, request.pool) && record.disabled === undefined,
		);
		const pinned = request.selector.kind !== "automatic";
		const matching = candidates.filter((record) => matchesSelector(record, request.selector));
		if (matching.length === 0) {
			throw new Error(pinned ? "No credential matches selector" : "No eligible credential is available");
		}
		const eligible = matching.filter((record) => !this.isCoolingDown(record.credentialId));
		if (eligible.length === 0) {
			throw new Error(pinned ? "No eligible credential matches selector" : "No eligible credential is available");
		}

		const affinityKey =
			request.sessionId === undefined ? undefined : `${credentialPoolKey(request.pool)}:${request.sessionId}`;
		if (!pinned && affinityKey !== undefined) {
			const affiliatedCredentialId = this.sessionAffinities.get(affinityKey);
			const affiliated = eligible.find((record) => record.credentialId === affiliatedCredentialId);
			if (affiliated !== undefined) return affiliated;
		}

		const selected = this.selectByScoreAndRoundRobin(eligible, request.pool);
		if (!pinned && affinityKey !== undefined) this.sessionAffinities.set(affinityKey, selected.credentialId);
		return selected;
	}

	reportOutcome(report: UsageReport): void {
		if (report.remainingFraction !== undefined)
			this.remainingFractions.set(report.credentialId, report.remainingFraction);
		const cooldown = cooldownForStatus(report.status);
		if (cooldown !== undefined) this.cooldowns.set(report.credentialId, this.now() + cooldown);
	}

	runRefresh<T>(credentialId: string, refresh: () => Promise<T>): Promise<T> {
		const existing = this.refreshes.get(credentialId) as Promise<T> | undefined;
		if (existing !== undefined) return existing;
		const inFlight = refresh().finally(() => this.refreshes.delete(credentialId));
		this.refreshes.set(credentialId, inFlight);
		return inFlight;
	}

	private isCoolingDown(credentialId: string): boolean {
		const until = this.cooldowns.get(credentialId);
		if (until === undefined) return false;
		if (until > this.now()) return true;
		this.cooldowns.delete(credentialId);
		return false;
	}

	private matchesPool(record: CredentialRecord, pool: CredentialPool): boolean {
		return credentialPoolKey(record.pool) === credentialPoolKey(pool);
	}

	private selectByScoreAndRoundRobin(candidates: readonly CredentialRecord[], pool: CredentialPool): CredentialRecord {
		const ranked = [...candidates].sort((left, right) => left.credentialId.localeCompare(right.credentialId));
		const bestScore = Math.max(...ranked.map((record) => this.remainingFractions.get(record.credentialId) ?? 1));
		const equalBest = ranked.filter(
			(record) => (this.remainingFractions.get(record.credentialId) ?? 1) === bestScore,
		);
		const key = credentialPoolKey(pool);
		const cursor = this.roundRobinCursors.get(key) ?? 0;
		const selected = equalBest[cursor % equalBest.length];
		if (selected === undefined) throw new Error("No eligible credential is available");
		this.roundRobinCursors.set(key, cursor + 1);
		return selected;
	}
}

function cooldownForStatus(status: UsageReport["status"]): number | undefined {
	switch (status) {
		case "rate_limited":
			return RATE_LIMIT_COOLDOWN_MS;
		case "unauthorized":
			return UNAUTHORIZED_COOLDOWN_MS;
		case "unavailable":
			return UNAVAILABLE_COOLDOWN_MS;
		case "success":
			return undefined;
		default:
			return assertNever(status);
	}
}

function matchesSelector(record: CredentialRecord, selector: CredentialSelector): boolean {
	switch (selector.kind) {
		case "automatic":
			return true;
		case "credential":
			return record.credentialId === selector.credentialId;
		case "identity":
			return record.identityKey === selector.identityKey;
		default:
			return assertNever(selector);
	}
}

function assertNever(value: never): never {
	void value;
	throw new Error("Unexpected credential selection variant");
}
