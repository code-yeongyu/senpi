/**
 * Process-wide state of the credential proxy (senpi#6820), shared by every engine copy through a realm registry as the
 * kill guard's runtime is. Withholding is keyed on the declaration, not on the proxy: a credential whose proxy failed
 * to start is still replaced by the placeholder in every agent child environment (fail closed).
 */
import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";
import { type CredentialDeclaration, parseCredentialDeclarations } from "./declarations.ts";
import { type CredentialProxy, type ProxiedCredential, startCredentialProxy } from "./proxy.ts";

export const CREDENTIAL_PLACEHOLDER = "senpi-credential-proxy-placeholder";

interface Hold {
	/** Variable name -> the engine's value at activation (absent when the engine had none). */
	readonly withheld: ReadonlyMap<string, string | undefined>;
	/** Child variable -> proxy route, set only once the proxy listens. */
	readonly routes: Map<string, string>;
}

interface CredentialProxyHolds {
	set(holder: object, hold: Hold): void;
	release(holder: object): Hold | undefined;
	all(): readonly Hold[];
}

const holds = realmRegistry(
	"@code-yeongyu/senpi/credential-proxy/v1",
	(): CredentialProxyHolds => {
		const byHolder = new Map<object, Hold>();
		return {
			set: (holder, hold) => {
				byHolder.delete(holder);
				byHolder.set(holder, hold);
			},
			release: (holder) => {
				const hold = byHolder.get(holder);
				byHolder.delete(holder);
				return hold;
			},
			all: () => [...byHolder.values()],
		};
	},
	(value): value is CredentialProxyHolds => hasFunctions(value, ["set", "release", "all"]),
);

const proxies = new Map<object, CredentialProxy>();

/** `env` with every declared credential, and any other variable carrying one of their values, set to the placeholder. */
export function withCredentialProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const active = holds.all();
	if (active.length === 0) return env;
	const names = new Set<string>();
	const values = new Set<string>();
	for (const hold of active)
		for (const [name, value] of hold.withheld) {
			names.add(name);
			if (value !== undefined && value !== "") values.add(value);
		}
	const result: NodeJS.ProcessEnv = { ...env };
	for (const [name, value] of Object.entries(result))
		if (names.has(name) || (value !== undefined && values.has(value))) result[name] = CREDENTIAL_PLACEHOLDER;
	for (const name of names) result[name] = CREDENTIAL_PLACEHOLDER;
	for (const hold of active) for (const [name, route] of hold.routes) result[name] = route;
	return result;
}

export interface ActivateCredentialProxyOptions {
	readonly holder: object;
	/** The raw `credentialProxy` value from the user's global settings. */
	readonly settings: unknown;
	readonly env?: NodeJS.ProcessEnv;
	readonly warn: (message: string) => void;
}

/**
 * Withholds every declared credential at once, then starts the proxy. Resolves after the proxy listens; rejects when it
 * cannot, leaving the credentials withheld and unrouted.
 */
export async function activateCredentialProxy(options: ActivateCredentialProxyOptions): Promise<void> {
	const previous = detach(options.holder);
	const env = options.env ?? process.env;
	const parsed = parseCredentialDeclarations(options.settings);
	const hold: Hold = {
		withheld: new Map(parsed.withheldNames.map((name) => [name, env[name]])),
		routes: new Map(),
	};
	if (parsed.withheldNames.length > 0) holds.set(options.holder, hold);
	await previous?.close();
	for (const problem of parsed.problems) options.warn(problem);
	if (parsed.withheldNames.length === 0) return;
	const proxied: ProxiedCredential[] = [];
	for (const declaration of parsed.credentials) {
		const value = env[declaration.env];
		if (value === undefined || value === "")
			options.warn(`credentialProxy: ${declaration.env} is not set in the engine environment; nothing to proxy`);
		else proxied.push({ declaration, value });
	}
	if (proxied.length === 0) return;
	const proxy = await startCredentialProxy(proxied);
	if (!holds.all().includes(hold)) {
		await proxy.close();
		return;
	}
	proxies.set(options.holder, proxy);
	for (const { declaration } of proxied) setRoute(hold, declaration, proxy);
}

function setRoute(hold: Hold, declaration: CredentialDeclaration, proxy: CredentialProxy): void {
	const route = proxy.routeFor(declaration.env);
	if (route !== undefined && declaration.baseUrlEnv !== undefined) hold.routes.set(declaration.baseUrlEnv, route);
}

function detach(holder: object): CredentialProxy | undefined {
	holds.release(holder);
	const proxy = proxies.get(holder);
	proxies.delete(holder);
	return proxy;
}

export async function releaseCredentialProxy(holder: object): Promise<void> {
	await detach(holder)?.close();
}
