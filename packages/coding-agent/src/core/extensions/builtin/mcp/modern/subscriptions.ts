import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mcpElapsedClock } from "../wrap.ts";
import type { DiscoveryResult } from "./era.ts";
import { isRecord } from "./form-schema.ts";

const subscriptionKey = "io.modelcontextprotocol/subscriptionId";
const listFilters = {
	"notifications/tools/list_changed": "toolsListChanged",
	"notifications/prompts/list_changed": "promptsListChanged",
	"notifications/resources/list_changed": "resourcesListChanged",
} as const;
type Filter = {
	toolsListChanged?: boolean;
	promptsListChanged?: boolean;
	resourcesListChanged?: boolean;
	resourceSubscriptions?: string[];
};
type Subscription = { id: string; requested: Filter; accepted?: Filter };
type ResourceSweep = { uris: string[] };

/** Connection-owned streams bypass the SDK's finite request timeout and MRTR consent lifecycle. */
export class ModernSubscriptions {
	readonly #send: Transport["send"];
	readonly #capabilities: DiscoveryResult["capabilities"];
	readonly #sendCompletesStream: boolean;
	readonly #filter: Filter = {};
	readonly #resourceLists = new Map<string | number, ResourceSweep>();
	readonly #resourceCursors = new Map<string, ResourceSweep>();
	#latestSweep?: ResourceSweep;
	#active?: Subscription;
	#pending?: Subscription;
	#timer?: ReturnType<typeof setTimeout>;
	#retry = 0;
	#closed = false;
	#started = false;

	constructor(send: Transport["send"], capabilities: DiscoveryResult["capabilities"], sendCompletesStream = false) {
		this.#send = send;
		this.#capabilities = capabilities;
		this.#sendCompletesStream = sendCompletesStream;
	}

	outgoing(message: JSONRPCMessage): void {
		if (!("method" in message)) return;
		if (message.method === "notifications/cancelled") {
			const id = message.params?.requestId;
			if (typeof id === "string" || typeof id === "number") this.#resourceLists.delete(id);
		}
		if (!("id" in message)) return;
		if (message.method === "resources/list" && this.#supports("resources", "subscribe")) {
			const cursor = message.params?.cursor;
			if (cursor === undefined) {
				const sweep: ResourceSweep = { uris: [] };
				this.#latestSweep = sweep;
				this.#resourceLists.set(message.id, sweep);
			} else if (typeof cursor === "string") {
				const sweep = this.#resourceCursors.get(cursor);
				this.#resourceCursors.delete(cursor);
				if (sweep) this.#resourceLists.set(message.id, sweep);
			}
		}
		if (this.#started || !["tools/list", "prompts/list", "resources/list"].includes(message.method)) return;
		this.#started = true;
		// The builtin catalog uses all three lists. Never opt in to an undeclared feature.
		if (this.#supports("tools", "listChanged")) this.#filter.toolsListChanged = true;
		if (this.#supports("prompts", "listChanged")) this.#filter.promptsListChanged = true;
		if (this.#supports("resources", "listChanged")) this.#filter.resourcesListChanged = true;
		this.#open();
	}

	/** Returns true only for application messages that may reach the existing SDK notification handlers. */
	incoming(message: JSONRPCMessage): boolean {
		const sweep = "id" in message && message.id !== undefined ? this.#resourceLists.get(message.id) : undefined;
		if ("id" in message && message.id !== undefined) this.#resourceLists.delete(message.id);
		if (sweep && "result" in message) {
			const resources = message.result.resources;
			if (Array.isArray(resources)) {
				for (const resource of resources)
					if (isRecord(resource) && typeof resource.uri === "string") sweep.uris.push(resource.uri);
				if (typeof message.result.nextCursor === "string" && message.result.nextCursor) {
					this.#resourceCursors.set(message.result.nextCursor, sweep);
				} else if (sweep === this.#latestSweep) {
					const uris = [...new Set(sweep.uris)].sort();
					if (JSON.stringify(uris) !== JSON.stringify(this.#filter.resourceSubscriptions ?? [])) {
						this.#filter.resourceSubscriptions = uris;
						this.#open();
					}
				}
			}
		}
		if ("id" in message) {
			const stream = [this.#active, this.#pending].find((entry) => entry?.id === message.id);
			if (!stream) return true;
			// A response ends the long-lived request; graceful server shutdown is not a retry trigger.
			this.#retire(stream);
			return false;
		}
		if (!("method" in message)) return true;
		if (message.method === "notifications/cancelled") {
			const stream = [this.#active, this.#pending].find((entry) => entry?.id === message.params?.requestId);
			if (stream) {
				this.#retire(stream);
				return false;
			}
		}
		const meta = message.params?._meta;
		const id = isRecord(meta) ? meta[subscriptionKey] : undefined;
		const acknowledged = message.method === "notifications/subscriptions/acknowledged";
		const list = Object.hasOwn(listFilters, message.method);
		const resource = message.method === "notifications/resources/updated";
		if (!acknowledged && !list && !resource) return true;
		const active = [this.#active, this.#pending].find((entry) => entry?.id === id);
		if (!active) return false;
		if (acknowledged) {
			if (active.accepted) return false;
			if (!isRecord(message.params?.notifications)) {
				this.#failed(active);
				this.#cancel(active);
				return false;
			}
			const offered = message.params.notifications;
			const accepted: Filter = {};
			for (const key of Object.values(listFilters))
				if (active.requested[key] && offered[key] === true) accepted[key] = true;
			const uris = offered.resourceSubscriptions;
			if (Array.isArray(uris))
				accepted.resourceSubscriptions = active.requested.resourceSubscriptions?.filter((uri) =>
					uris.includes(uri),
				);
			active.accepted = accepted;
			const previous = this.#active;
			this.#pending = undefined;
			this.#active = active;
			if (previous && previous !== active) this.#cancel(previous);
			if (!Object.values(accepted).some((value) => value === true) && !accepted.resourceSubscriptions?.length)
				this.#cancel(active);
			return false;
		}
		if (active !== this.#active || !active.accepted) return false;
		const deliver = resource
			? typeof message.params?.uri === "string" &&
				active.accepted.resourceSubscriptions?.includes(message.params.uri) === true
			: active.accepted[listFilters[message.method as keyof typeof listFilters]] === true;
		if (deliver) this.#retry = 0;
		return deliver;
	}

	failedSend(message: JSONRPCMessage): void {
		if ("id" in message && message.id !== undefined) this.#resourceLists.delete(message.id);
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) mcpElapsedClock.cancel(this.#timer);
		this.#timer = undefined;
		if (this.#pending) this.#cancel(this.#pending);
		if (this.#active) this.#cancel(this.#active);
		this.#resourceLists.clear();
		this.#resourceCursors.clear();
		this.#latestSweep = undefined;
	}

	#supports(feature: string, flag: string): boolean {
		const capability = this.#capabilities[feature];
		return isRecord(capability) && capability[flag] === true;
	}

	#retire(active: Subscription): void {
		if (this.#active === active) this.#active = undefined;
		if (this.#pending === active) this.#pending = undefined;
	}

	#cancel(active: Subscription): void {
		this.#retire(active);
		void this.#send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: active.id },
		}).catch(() => {});
	}

	#open(): void {
		if (this.#closed || JSON.stringify((this.#pending ?? this.#active)?.requested) === JSON.stringify(this.#filter))
			return;
		if (this.#timer) mcpElapsedClock.cancel(this.#timer);
		this.#timer = undefined;
		if (this.#pending) this.#cancel(this.#pending);
		if (!Object.values(this.#filter).some((value) => value === true) && !this.#filter.resourceSubscriptions?.length) {
			if (this.#active) this.#cancel(this.#active);
			return;
		}
		const active = { id: `senpi-subscription-${randomUUID()}`, requested: structuredClone(this.#filter) };
		this.#pending = active;
		// HTTP send remains pending for the entire SSE lifetime. No caller awaits it.
		void this.#send({
			jsonrpc: "2.0",
			id: active.id,
			method: "subscriptions/listen",
			params: { notifications: active.requested },
		}).then(
			() => {
				if (this.#sendCompletesStream) this.#failed(active);
			},
			() => this.#failed(active),
		);
	}

	#failed(active: Subscription): void {
		if (this.#closed || (this.#active !== active && this.#pending !== active)) return;
		this.#retire(active);
		if (this.#pending || this.#timer) return;
		this.#timer = mcpElapsedClock.schedule(
			() => {
				this.#timer = undefined;
				this.#open();
			},
			Math.min(30_000, 1000 * 2 ** Math.min(this.#retry++, 5)),
		);
		this.#timer.unref?.();
	}
}
