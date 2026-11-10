import type { OpenRpcSession } from "./session-registry.ts";

/** Speculation is bounded independently of the unlimited in-process session registry. */
const MAX_PARKS = 4;
const PARK_TTL_MS = 60_000;

interface Park {
	readonly ready: Promise<void>;
	opened?: OpenRpcSession;
	expiry?: ReturnType<typeof setTimeout>;
	claim?: PromiseWithResolvers<void>;
	closing?: Promise<void>;
}

/** Owns both in-flight builds and ready parks, including the races with claim, expiry and shutdown. */
export class HostParkLedger {
	private readonly parks = new Map<string, Park>();
	private readonly replacements = new Map<string, ReturnType<typeof setTimeout>>();
	private stopped = false;
	private readonly close: (opened: OpenRpcSession) => Promise<void>;
	constructor(close: (opened: OpenRpcSession) => Promise<void>) {
		this.close = close;
	}

	get size(): number {
		return this.parks.size;
	}

	async park(key: string, build: () => Promise<OpenRpcSession>): Promise<"parked" | "already_parked" | "full"> {
		const existing = this.parks.get(key);
		if (existing) {
			await existing.ready;
			return "already_parked";
		}
		const replacement = this.replacements.get(key);
		if (replacement !== undefined) {
			clearTimeout(replacement);
			this.replacements.delete(key);
		}
		if (this.stopped) throw new Error("host_draining");
		if (this.parks.size + this.replacements.size >= MAX_PARKS) return "full";
		const ready = Promise.withResolvers<void>();
		ready.promise.catch(() => {});
		const park: Park = { ready: ready.promise };
		// Reserved before build's first await: a second request joins, never starts another runtime.
		this.parks.set(key, park);
		try {
			park.opened = await build();
			if (!this.stopped) {
				park.expiry = setTimeout(() => void this.retire(key, park), PARK_TTL_MS);
				park.expiry.unref?.();
			}
			ready.resolve();
			if (this.stopped) await this.retire(key, park);
			return "parked";
		} catch (cause) {
			this.parks.delete(key);
			ready.reject(cause);
			throw cause;
		}
	}

	/** A claim never waits for a build, and consumes the ready park synchronously. */
	take(key: string): OpenRpcSession | undefined {
		const park = this.parks.get(key);
		if (this.stopped || !park?.opened || park.claim || park.closing) return undefined;
		clearTimeout(park.expiry);
		park.claim = Promise.withResolvers<void>();
		return park.opened;
	}

	finish(key: string): void {
		const park = this.parks.get(key);
		this.parks.delete(key);
		park?.claim?.resolve();
	}

	replace(key: string, build: () => Promise<OpenRpcSession>): void {
		if (this.stopped || this.replacements.has(key)) return;
		const timer = setTimeout(() => {
			this.replacements.delete(key);
			void this.park(key, build).catch((cause: unknown) => {
				process.stderr.write(`senpi rpc replacement park failed: ${String(cause)}\n`);
			});
		}, 0);
		timer.unref?.();
		this.replacements.set(key, timer);
	}

	/** Fences new builds synchronously; every build already accepted is closed when it finishes. */
	async stop(): Promise<void> {
		this.stopped = true;
		for (const timer of this.replacements.values()) clearTimeout(timer);
		this.replacements.clear();
		await Promise.all(
			[...this.parks].map(async ([key, park]) => {
				await park.ready.catch(() => {});
				if (park.claim) await park.claim.promise;
				else await this.retire(key, park);
			}),
		);
	}

	private retire(key: string, park: Park): Promise<void> {
		clearTimeout(park.expiry);
		park.closing ??= (async () => {
			try {
				if (park.opened) await this.close(park.opened);
			} finally {
				if (this.parks.get(key) === park) this.parks.delete(key);
			}
		})();
		return park.closing;
	}
}
