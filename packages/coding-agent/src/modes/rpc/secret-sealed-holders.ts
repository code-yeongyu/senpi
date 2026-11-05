import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import type { AccountPrincipal, PresenterAccountAuthority } from "./mcp-presenter-account.ts";
import { accountLapse } from "./mcp-presenter-account-lifetime.ts";
import type { McpPresenterAuthority } from "./mcp-presenter-authority.ts";
import type { Grant } from "./mcp-presenter-grants.ts";
import type { PresenterHostSurface } from "./mcp-presenter-host-surface.ts";
import { SecretHostTokens } from "./secret-host-token.ts";
import { secretBinding } from "./secret-sealed.ts";

/** A grant that may answer one request on the sealed route; opaque outside this module. */
export type SealedHolder = Grant;

export interface SealedSecretOffer {
	readonly uiRequestId: string;
	readonly title: string;
	readonly placeholder: string | undefined;
	readonly deadlineAtMs: number;
	readonly hpkePk: string;
}

/** What the secret route reads from the presenter control (D11 secret phase 5.1, 5.2). */
export interface SealedSecretSource {
	/** The sealed holders of the session now: the snapshot a request keeps for its whole life. */
	holders(sessionId: string): ReadonlySet<SealedHolder>;
	/** The holder's grant is still current (5.2 `available`). */
	current(holder: SealedHolder): boolean;
	connectionOf(holder: SealedHolder): string;
	/** Builds `B`, signs it with the host key and sends each holder `mcp_presenter_secret_request` (4.3). */
	offer(sessionId: string, holders: ReadonlySet<SealedHolder>, offer: SealedSecretOffer): void;
	/** The request settled or was forgotten: it takes no further host token refreshes. */
	withdraw(uiRequestId: string): void;
	/** Fires whenever a grant on a binding the source has read is acquired or revoked. */
	onChange(listener: () => void): () => void;
}

/** The control's principals, keyed by id; only an account principal can hold a sealed grant. */
type PrincipalsById = ReadonlyMap<string, AccountPrincipal | { readonly kind: "inherited" }>;

interface Offered {
	readonly durableSessionId: string;
	readonly holders: ReadonlySet<SealedHolder>;
}

/** The control's sealed holders: eligibility, signed requests and token refreshes, all synchronous. */
export class SealedSecretHolders implements SealedSecretSource {
	readonly tokens: SecretHostTokens;
	private readonly host: PresenterHostSurface;
	private readonly authority: McpPresenterAuthority;
	private readonly account: PresenterAccountAuthority;
	private readonly principals: PrincipalsById;
	private readonly offered = new Map<string, Offered>();
	private readonly listeners = new Set<() => void>();
	private readonly watched = new WeakSet<McpFormBinding>();
	private readonly detach: (() => void) | undefined;
	private readonly unsubscribe: () => void;

	/** `undefined` when the authority cannot mint host tokens and verify step-up tokens: no sealed route at all. */
	static create(
		host: PresenterHostSurface,
		account: PresenterAccountAuthority | undefined,
		principals: PrincipalsById,
	): SealedSecretHolders | undefined {
		const tokens = SecretHostTokens.create(host.authority.instance, account);
		return tokens && account ? new SealedSecretHolders(host, account, tokens, principals) : undefined;
	}

	private constructor(
		host: PresenterHostSurface,
		account: PresenterAccountAuthority,
		tokens: SecretHostTokens,
		principals: PrincipalsById,
	) {
		this.host = host;
		this.authority = host.authority;
		this.account = account;
		this.tokens = tokens;
		this.principals = principals;
		this.unsubscribe = tokens.onToken((durableSessionId, token) => {
			for (const offered of this.offered.values())
				if (offered.durableSessionId === durableSessionId)
					for (const holder of offered.holders)
						if (this.current(holder))
							holder.registration.connection.send({
								type: "mcp_presenter_secret_token",
								v: 1,
								hostInstance: this.authority.instance,
								durableSessionId,
								hostToken: token.token,
							});
		});
		this.detach = host.attachSealedSecrets?.(this);
	}

	holders(sessionId: string): ReadonlySet<SealedHolder> {
		const binding = this.host.getMcpFormBinding(sessionId);
		if (!binding) return new Set();
		if (binding.subscribe && !this.watched.has(binding)) {
			this.watched.add(binding);
			binding.subscribe(() => {
				for (const listener of [...this.listeners]) listener();
			});
		}
		return new Set(
			this.authority
				.secretCandidates(binding)
				.filter((grant) => this.eligible(grant) && this.tokens.current(grant.scope.durableSessionId)),
		);
	}

	current(holder: SealedHolder): boolean {
		return this.authority.isCurrent(holder);
	}

	connectionOf(holder: SealedHolder): string {
		return holder.registration.connection.id;
	}

	offer(sessionId: string, holders: ReadonlySet<SealedHolder>, offer: SealedSecretOffer): void {
		const first = [...holders][0];
		if (!first) return;
		const durableSessionId = first.scope.durableSessionId;
		const token = this.tokens.current(durableSessionId);
		if (!token) return;
		const binding = secretBinding({
			hostInstance: this.authority.instance,
			hostJkt: this.tokens.hostJkt,
			durableSessionId,
			...offer,
		});
		const sig = this.tokens.signRequest(binding);
		this.offered.set(offer.uiRequestId, { durableSessionId, holders });
		for (const holder of holders)
			holder.registration.connection.send({
				type: "mcp_presenter_secret_request",
				v: 1,
				sessionId,
				durableSessionId,
				uiRequestId: offer.uiRequestId,
				title: offer.title,
				...(offer.placeholder === undefined ? {} : { placeholder: offer.placeholder }),
				deadlineAtMs: offer.deadlineAtMs,
				hostInstance: this.authority.instance,
				hpkePk: offer.hpkePk,
				hostPk: this.tokens.hostPk,
				hostToken: token.token,
				sig,
			});
	}

	withdraw(uiRequestId: string): void {
		this.offered.delete(uiRequestId);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.detach?.();
		this.unsubscribe();
		this.listeners.clear();
		this.offered.clear();
		this.tokens.dispose();
	}

	/** 5.1 condition 4 (the principal has not lapsed); conditions 1-3 come from `secretCandidates`, 5 from the caller. */
	private eligible(grant: Grant): boolean {
		const principal = this.principals.get(grant.registration.principal);
		return principal?.kind === "account" && accountLapse(principal, this.account) === undefined;
	}
}
