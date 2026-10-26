import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { ManagedCommand } from "./managed-launch-process.ts";
import { ManagedLaunchError, type SessionLaunchSupervisor } from "./session-launch-supervisor.ts";

export interface ServiceRequest {
	readonly command: ManagedCommand;
	/** Only an affirmative absence result permits startup. Permission/protocol failures reject. */
	readonly probe?: () => Promise<"available" | "missing">;
}

export interface ServiceView {
	readonly key: string;
	readonly ownership: "session" | "external";
	readonly state: "started" | "exited" | "external";
	readonly pid?: number;
	readonly logPath?: string;
	readonly exitCode?: number;
}

interface ServiceOwner {
	readonly supervisor: SessionLaunchSupervisor;
	closed: boolean;
	entries: number;
}

type ServiceRecord =
	| { readonly ownership: "external" }
	| { readonly ownership: "session"; readonly id: string; readonly pid: number; readonly logPath: string };

interface ServiceEntry {
	readonly key: string;
	readonly creator: ServiceOwner;
	readonly command: ManagedCommand;
	readonly launchOwnerId: string;
	readonly leases: Set<ServiceOwner>;
	readonly ready: Promise<ServiceRecord>;
	retiring: boolean;
	exitCode?: number;
}

/**
 * The daemon a request names: its OS user, key, executable, arguments and environment (its home included). Only the
 * working directory may differ between two leases of one daemon; anything else is another daemon.
 */
function serviceIdentity(user: string, key: string, { command, args, env }: ManagedCommand): string {
	const variables = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify([user, key, command, args, variables]);
}

function currentUser(): string {
	const { uid, username } = userInfo();
	return `${uid}:${username}`;
}

/** Leases across sessions in this host. A daemon owned by another host remains external and is never adopted. */
export class SessionServicePool {
	readonly #entries = new Map<string, ServiceEntry>();

	async acquire(owner: ServiceOwner, identity: string, key: string, request: ServiceRequest): Promise<ServiceView> {
		let entry = this.#entries.get(identity);
		const reused = entry !== undefined;
		if (entry !== undefined) {
			if (entry.retiring)
				throw new ManagedLaunchError("managed_service_stopping", `${key} is still releasing its final lease`);
			const { logPath: _previousLog, ...previous } = entry.command;
			const { logPath: _newLog, ...incoming } = request.command;
			if (!isDeepStrictEqual(previous, incoming)) {
				// Another workspace can lease the same endpoint, but only a positive probe proves that identity.
				await entry.ready;
				if ((await request.probe?.()) !== "available")
					throw new ManagedLaunchError("managed_service_conflict", `${key} is registered with another command`);
				if (this.#entries.get(identity) !== entry || entry.retiring)
					throw new ManagedLaunchError("managed_service_stopping", `${key} is releasing its final lease`);
			}
			entry.leases.add(owner);
		} else {
			const ready = Promise.withResolvers<ServiceRecord>();
			entry = {
				key,
				creator: owner,
				command: request.command,
				launchOwnerId: `service:${randomUUID()}`,
				leases: new Set([owner]),
				ready: ready.promise,
				retiring: false,
			};
			owner.entries += 1;
			this.#entries.set(identity, entry);
			void this.#start(entry, request).then(ready.resolve, ready.reject);
		}
		try {
			const record = await entry.ready;
			if (owner.closed) throw new ManagedLaunchError("managed_session_closed", "the session has ended");
			if (reused && record.ownership === "external" && (await request.probe?.()) === "missing")
				throw new ManagedLaunchError("managed_external_service_unavailable", `${key} is no longer available`);
			return this.#view(entry, record);
		} catch (error) {
			await this.release(owner, identity);
			throw error;
		}
	}

	async #start(entry: ServiceEntry, request: ServiceRequest): Promise<ServiceRecord> {
		if ((await request.probe?.()) === "available") return { ownership: "external" };
		if (entry.leases.size === 0)
			throw new ManagedLaunchError("managed_launch_cancelled", "all service leases were released before startup");
		const launch = await entry.creator.supervisor.start(request.command, entry.launchOwnerId);
		void launch.completed.then((exitCode) => {
			entry.exitCode = exitCode;
		});
		return { ownership: "session", id: launch.id, pid: launch.pid, logPath: request.command.logPath };
	}

	#view(entry: ServiceEntry, record: ServiceRecord): ServiceView {
		switch (record.ownership) {
			case "external":
				return { key: entry.key, ownership: "external", state: "external" };
			case "session":
				return {
					key: entry.key,
					ownership: "session",
					state: entry.exitCode === undefined ? "started" : "exited",
					pid: record.pid,
					logPath: record.logPath,
					...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
				};
		}
	}

	holds(owner: ServiceOwner, identity: string): boolean {
		return this.#entries.get(identity)?.leases.has(owner) === true;
	}

	async list(owner: ServiceOwner): Promise<ServiceView[]> {
		const entries = [...this.#entries.values()].filter((entry) => entry.leases.has(owner));
		return Promise.all(entries.map(async (entry) => this.#view(entry, await entry.ready)));
	}

	async release(owner: ServiceOwner, identity: string): Promise<void> {
		const entry = this.#entries.get(identity);
		if (entry === undefined || !entry.leases.delete(owner) || entry.leases.size > 0) return;
		entry.retiring = true;
		// Cancel admission before joining the start, rather than letting an abandoned probe start user code later.
		await entry.creator.supervisor.cancel(entry.launchOwnerId);
		await entry.ready.then(
			async (record) => {
				if (record.ownership === "session") await entry.creator.supervisor.stop(record.id);
			},
			() => undefined, // A rejected start already reaped its own partial launch.
		);
		if (this.#entries.get(identity) === entry) {
			this.#entries.delete(identity);
			entry.creator.entries -= 1;
		}
		await this.retire(entry.creator);
	}

	async retire(owner: ServiceOwner): Promise<void> {
		if (owner.closed && owner.entries === 0) await owner.supervisor.close();
	}
}

const sharedServices = new SessionServicePool();

/** A session owns leases, not another session's daemon. The final lease stops a host-owned service. */
export class SessionServices {
	readonly #owner: ServiceOwner;
	readonly #pool: SessionServicePool;
	readonly #user: string;
	/** This session's key -> the identity of the daemon it leases under that key. */
	readonly #keys = new Map<string, string>();
	#closing: Promise<void> | undefined;

	constructor(
		supervisor: SessionLaunchSupervisor,
		pool: SessionServicePool = sharedServices,
		options: { readonly user?: string } = {},
	) {
		this.#owner = { supervisor, entries: 0, closed: false };
		this.#pool = pool;
		this.#user = options.user ?? currentUser();
	}

	async ensure(key: string, request: ServiceRequest): Promise<ServiceView> {
		if (this.#owner.closed) throw new ManagedLaunchError("managed_session_closed", "the session has ended");
		const identity = serviceIdentity(this.#user, key, request.command);
		const leased = this.#keys.get(key);
		if (leased !== undefined && leased !== identity)
			throw new ManagedLaunchError(
				"managed_service_conflict",
				`${key} already names another daemon in this session`,
			);
		this.#keys.set(key, identity);
		try {
			return await this.#pool.acquire(this.#owner, identity, key, request);
		} catch (error) {
			if (!this.#pool.holds(this.#owner, identity) && this.#keys.get(key) === identity) this.#keys.delete(key);
			throw error;
		}
	}

	async release(key: string): Promise<void> {
		const identity = this.#keys.get(key);
		if (identity === undefined) return;
		this.#keys.delete(key);
		await this.#pool.release(this.#owner, identity);
	}

	list(): Promise<ServiceView[]> {
		return this.#pool.list(this.#owner);
	}

	close(): Promise<void> {
		this.#owner.closed = true;
		this.#closing ??= (async () => {
			await Promise.all([...this.#keys.keys()].map((key) => this.release(key)));
			await this.#pool.retire(this.#owner);
		})();
		return this.#closing;
	}
}
