import * as path from "node:path";
import type { PermissionEventEmitter } from "./events.ts";
import type { CanonicalRule } from "./path-identity.ts";
import type { PathIdentityResolver } from "./path-identity-host.ts";
import type { Rule } from "./types.ts";
import { Wildcard } from "./wildcard.ts";

export type RuleIdentityEntry = CanonicalRule | "literal-only" | "timed-out" | "pending";

interface RuleIdentity {
	entry: RuleIdentityEntry;
	fill?: Promise<void>;
	/** Whether the anchored prefix goes through an alias; undefined while the worker has not answered. */
	aliasBearing: boolean | undefined;
	/** The open-free walk of the anchored prefix, computed once per rules load; null when the walk failed. */
	walkedPrefix?: string | null;
}

/** Rule-side canonical forms, per pattern, filled through the resolver worker (6.5). */
export class RuleIdentityCache {
	private readonly ruleIdentities = new Map<string, RuleIdentity>();

	private readonly resolver: PathIdentityResolver | undefined;
	private readonly projectDir: string | undefined;
	private readonly pathRules: () => Rule[];
	private readonly emitter: PermissionEventEmitter;

	constructor(
		resolver: PathIdentityResolver | undefined,
		projectDir: string | undefined,
		pathRules: () => Rule[],
		emitter: PermissionEventEmitter,
	) {
		this.resolver = resolver;
		this.projectDir = projectDir;
		this.pathRules = pathRules;
		this.emitter = emitter;
	}

	anchoredPrefix(pattern: string): string {
		const wildcard = pattern.search(/[*?]/u);
		const literal = wildcard < 0 ? pattern : pattern.slice(0, Math.max(pattern.lastIndexOf("/", wildcard), 0));
		if (literal === "") return "";
		return path.isAbsolute(literal) ? literal : path.join(this.projectDir ?? process.cwd(), literal);
	}

	/** Eager fill at rules load (R3-H1): one SOFT request per rule, outside the stall machinery. */
	fillAll(): void {
		if (!this.resolver) return;
		for (const rule of this.pathRules()) this.fillRule(rule.pattern, true);
	}

	fillRule(pattern: string, soft: boolean): RuleIdentity {
		const existing = this.ruleIdentities.get(pattern);
		if (existing?.fill) return existing;
		const resolver = this.resolver;
		if (!resolver) return existing ?? { entry: "literal-only", aliasBearing: false };
		const retry =
			existing?.entry === "timed-out" &&
			resolver.breakerState(resolver.volumeKey(this.anchoredPrefix(pattern))) !== "open";
		if (existing && existing.entry !== "pending" && !retry) return existing;
		const identity: RuleIdentity = existing ?? { entry: "pending", aliasBearing: undefined };
		this.ruleIdentities.set(pattern, identity);
		const prefix = this.anchoredPrefix(pattern);
		if (prefix === "" && identity.aliasBearing === undefined) identity.aliasBearing = false;
		const live = () => this.ruleIdentities.get(pattern) === identity;
		if (identity.aliasBearing === undefined) {
			const store = (alias: boolean) => {
				if (live()) identity.aliasBearing = alias;
			};
			void resolver.detect(prefix, { soft, onLate: (value) => store(value !== false) }).then((alias) => {
				if (!soft || alias === false) store(alias);
			});
		}
		if (identity.walkedPrefix === undefined && prefix !== "") {
			const storeWalk = (value: string | null) => {
				if (live()) identity.walkedPrefix = value;
			};
			void resolver
				.walk(prefix, { soft, onLate: (value) => storeWalk(typeof value === "string" ? value : null) })
				.then(
					(walked) => storeWalk(walked),
					(error: unknown) => {
						if ((error as { code?: string }).code !== "ETIMEDOUT") storeWalk(null);
					},
				);
		}
		const storeRule = (rule: CanonicalRule | undefined) => {
			if (!live()) return;
			identity.entry = rule ?? "literal-only";
			identity.fill = undefined;
		};
		const fill = resolver
			.canonicalizeRule(pattern, this.projectDir, {
				soft,
				onLate: (value) => storeRule(value as CanonicalRule | undefined),
			})
			.then(storeRule, (error: unknown) => {
				if (this.ruleIdentities.get(pattern) !== identity) return;
				identity.fill = undefined;
				const code = (error as { code?: string }).code ?? "EUNKNOWN";
				if (code === "ETIMEDOUT") {
					// A soft miss leaves the lazy entry pending; a hard miss marks it timed out until the next probe.
					const was = identity.entry;
					identity.entry = soft ? "pending" : "timed-out";
					if (!soft && was !== "timed-out") {
						for (const rule of this.pathRules()) {
							if (rule.pattern === pattern && rule.action === "deny") {
								this.emitter.emitRuleIdentityUnavailable({ permission: rule.permission, pattern, code });
							}
						}
					}
					return;
				}
				identity.entry = "literal-only";
				if (code !== "EUNAVAILABLE")
					console.warn(`permission: rule ${pattern} keeps literal matching only (${code})`);
			});
		identity.fill = fill;
		return identity;
	}

	/** The cached identity state of one rule pattern. */
	stateOf(pattern: string): RuleIdentityEntry {
		return this.ruleIdentities.get(pattern)?.entry ?? "pending";
	}

	/**
	 * The rule's form with the resolver UNAVAILABLE: its anchored spelling as written, split at the first
	 * wildcard like the worker would, with no realpath. A rule written on a canonical spelling still meets a
	 * JS cell's kernel canonical this way; a rule written through an alias does not, and that is the
	 * documented cost of a worker that could not start.
	 */
	lexicalForm(pattern: string): CanonicalRule | undefined {
		if (pattern === "*") return undefined;
		const foldCase = process.platform === "darwin" || process.platform === "win32";
		const wildcard = pattern.search(/[*?]/u);
		if (wildcard < 0) return { prefix: this.anchoredPrefix(pattern), foldCase, suffix: "", wildcardOnly: false };
		const boundary = Math.max(pattern.lastIndexOf("/", wildcard), pattern.lastIndexOf(path.sep, wildcard));
		if (boundary < 0) return { prefix: undefined, foldCase, suffix: pattern, wildcardOnly: true };
		return { prefix: this.anchoredPrefix(pattern), foldCase, suffix: pattern.slice(boundary), wildcardOnly: false };
	}

	/** Whether a rule's prefix goes through an alias; true while the worker has not answered yet. */
	aliasBearing(pattern: string): boolean {
		return this.ruleIdentities.get(pattern)?.aliasBearing ?? true;
	}

	walkedPrefix(pattern: string): string | null | undefined {
		return this.ruleIdentities.get(pattern)?.walkedPrefix;
	}

	/**
	 * A decided non-read operation may have retargeted a rule chain (6.5, M3): drop the cached form of every
	 * rule whose anchored prefix shares a path with the mutated one, or every rule when no path is known.
	 */
	noteMutation(mutated?: string): void {
		for (const pattern of [...this.ruleIdentities.keys()]) {
			const prefix = this.anchoredPrefix(pattern);
			const related =
				mutated === undefined ||
				prefix === mutated ||
				prefix.startsWith(`${mutated}${path.sep}`) ||
				mutated.startsWith(`${prefix}${path.sep}`);
			if (!related) continue;
			this.ruleIdentities.delete(pattern);
		}
	}

	/** DENY rules of the class whose identity form is timed out or behind an open breaker (T(P) of 6.5.1). */
	timedOutDenies(permission: string): Rule[] {
		return this.pathRules().filter(
			(rule) =>
				rule.action === "deny" &&
				Wildcard.match(permission, rule.permission) &&
				this.stateOf(rule.pattern) === "timed-out",
		);
	}

	/** Await every pending lazy fill a decision of this class needs; sync when nothing is pending. */
	settleRules(permission: string): Promise<void> | undefined {
		const pending: Promise<void>[] = [];
		for (const rule of this.pathRules()) {
			if (!Wildcard.match(permission, rule.permission)) continue;
			const identity = this.fillRule(rule.pattern, false);
			if (identity.fill) pending.push(identity.fill);
		}
		return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
	}

	/** Resolves once every in-flight rule fill (eager or lazy) has settled. */
	async settled(): Promise<void> {
		const fills = [...this.ruleIdentities.values()]
			.map((identity) => identity.fill)
			.filter((fill) => fill !== undefined);
		await Promise.all(fills);
	}
}
