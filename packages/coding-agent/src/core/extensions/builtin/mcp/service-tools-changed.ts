import type { ExtensionAPI } from "../../types.ts";
import { cachedToolsToCatalogEntries, collectToolCatalog, mcpRegistrationIdentity } from "./catalog.ts";
import { collectServerCatalogForCache, writeMcpCachedServer } from "./catalog-cache.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";
import { mapMcpCatalogNames } from "./expose/register.ts";
import {
	buildMcpTombstoneDefinition,
	createMcpListChangeCoalescer,
	diffMcpToolNames,
	formatMcpListChangedDelta,
} from "./notifications.ts";
import type { McpConnectionEntry } from "./service-types.ts";
import { SharedMcpLease } from "./shared-lease.ts";
import type { McpAsyncErrorSink } from "./wrap.ts";

type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

/** One session's registration of a server's catalog: a refresh re-registers it there when stale. */
export interface McpToolsRefreshTarget {
	readonly pi: McpToolRegistrar;
	readonly registeredIdentity: () => string | undefined;
	readonly register: () => Promise<void>;
}

/** Coalesce a server's tools-changed signals into one refresh. `connectOnly` is true when
 * every merged signal came from a connect rather than from a reported change. */
export function subscribeMcpToolsChanged(
	entry: McpConnectionEntry,
	refresh: (connectOnly: boolean) => Promise<void>,
	sink: McpAsyncErrorSink,
): () => void {
	let changeReported = false;
	const coalescer = createMcpListChangeCoalescer({
		onRefresh: () => {
			const connectOnly = !changeReported;
			changeReported = false;
			return refresh(connectOnly);
		},
		scope: `mcp.list_changed.${entry.name}`,
		sink,
	});
	const unsubscribe = entry.connection.onToolsChanged((event) => {
		if (event.cause !== "connect") changeReported = true;
		coalescer.notify();
	});
	return () => {
		unsubscribe();
		coalescer.dispose();
	};
}

/**
 * Re-list a server on a coalesced tools-changed signal and re-register: added
 * tools enter INACTIVE (registerToolsPreservingActiveSet keeps the active set),
 * and removed tools are tombstoned so a stale call fails cleanly. Every connect
 * raises the signal too; a connect-only refresh leaves an unchanged catalog
 * registered, so the catalog lands once per session (#2177). Every live session sharing the
 * connection is a target, resolved when registration starts and again until no session that
 * attached mid-refresh is left out; each re-registers in its own tool set, and one session's
 * failure is reported without starving the others (#2514).
 */
export async function refreshMcpToolsOnListChanged(
	entry: McpConnectionEntry,
	targets: () => readonly McpToolsRefreshTarget[],
	config: ResolvedMcpConfig,
	connectOnly: boolean,
): Promise<void> {
	const server = config.servers[entry.name];
	if (server?.config === undefined || entry.connection.state !== "connected") return;
	if (entry.isCurrent?.() === false) return;
	if (entry.credentialsCurrent?.() === false) {
		await entry.onCredentialsChanged?.();
		return;
	}
	const generation = entry.connection.generation;
	const ownsCatalog = () =>
		entry.isCurrent?.() !== false &&
		entry.credentialsCurrent?.() !== false &&
		entry.connection.generation === generation &&
		entry.connection.state === "connected";
	// The startup connect that still owns registration registers its refreshed catalog itself.
	if (connectOnly && entry.startupCatalogClaim?.ownsRegistration() === true) return;
	const registeredCatalog = entry.cachedCatalog;
	if (entry.connection instanceof SharedMcpLease) {
		const refreshed = await entry.connection.catalog();
		if (!ownsCatalog()) return;
		entry.cachedCatalog = refreshed;
	}
	const catalog = await collectToolCatalog(entry.name, entry.connection, server.config, {
		agentDir: entry.agentDir,
		outputGuard: config.settings.outputGuard,
	});
	if (!ownsCatalog()) return;
	const newNames = mapMcpCatalogNames(catalog).map(({ name }) => name);
	// Before the first refresh, the registered names are the catalog the startup pass registered.
	const knownNames =
		entry.knownToolNames ??
		(registeredCatalog === undefined
			? newNames
			: mapMcpCatalogNames(
					cachedToolsToCatalogEntries(
						entry.name,
						registeredCatalog,
						entry.connection,
						server.config.requestTimeoutMs,
						async () => {},
					),
				).map(({ name }) => name));
	const diff = diffMcpToolNames(knownNames, newNames);
	const identity = mcpRegistrationIdentity(catalog, entry.cachedCatalog);
	const initial = targets();
	const stale = connectOnly ? initial.filter((target) => target.registeredIdentity() !== identity) : initial;
	if (stale.length > 0) {
		// Registration reads entry.cachedCatalog. A shared lease refreshed it above; nothing else
		// refreshes a non-shared connection's catalog after its startup connect (#2188).
		if (!(entry.connection instanceof SharedMcpLease)) {
			const refreshed = await collectServerCatalogForCache(
				entry.connection,
				server.config,
				entry.configHash,
				entry.credentialIdentity,
			);
			if (!ownsCatalog()) return;
			entry.cachedCatalog = refreshed;
			await writeMcpCachedServer(entry.agentDir, entry.name, refreshed, ownsCatalog);
		}
		if (!ownsCatalog()) return;
		// Tombstone removed tools BEFORE re-registration so the subsequent
		// setActiveTools (which excludes them) leaves the tombstones inactive.
		const seen = new Set<object>(initial.map((target) => target.pi));
		const failures: unknown[] = [];
		let pending: readonly McpToolsRefreshTarget[] = stale;
		while (pending.length > 0) {
			for (const target of pending) {
				if (!ownsCatalog()) return;
				try {
					for (const removed of diff.removed)
						target.pi.registerTool(buildMcpTombstoneDefinition(removed, entry.name));
					await target.register();
				} catch (error) {
					failures.push(error);
				}
			}
			// A session that attached during this refresh registered the catalog cached before it.
			pending = targets().filter((target) => !seen.has(target.pi));
			for (const target of pending) seen.add(target.pi);
		}
		if (failures.length > 0) {
			entry.knownToolNames = newNames;
			entry.lastListChangedDelta = formatMcpListChangedDelta(diff);
			throw new AggregateError(
				failures,
				`MCP ${entry.name} tool refresh failed in ${failures.length} of ${seen.size} session(s)`,
			);
		}
	}
	entry.knownToolNames = newNames;
	entry.lastListChangedDelta = formatMcpListChangedDelta(diff);
}
