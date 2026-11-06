import type { Database } from "bun:sqlite";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { DurableStore, DurableStoreOptions } from "@earendil-works/pi-agent-core/conformance";
import { openSqliteStore } from "./store.ts";

/** An open file as the OS counts it: until `close()`, the OS may refuse to delete or rename it. */
export interface HeldFile {
	close(): Promise<void>;
}

/**
 * The filesystem media live on. Paths are the platform's own (`C:\dir\medium` on Windows); `resolve` maps one to the
 * path SQLite opens. `hold` records the handle SQLite keeps on a store file for as long as a connection is open.
 */
export interface MediaFileSystem {
	join(...segments: string[]): string;
	resolve(target: string): Promise<string>;
	mkdir(target: string): Promise<void>;
	rm(target: string): Promise<void>;
	hold(target: string): Promise<HeldFile>;
}

const NATIVE_FILE_SYSTEM: MediaFileSystem = {
	join: (...segments) => path.join(...segments),
	resolve: async (target) => target,
	mkdir: async (target) => void (await fsp.mkdir(target, { recursive: true })),
	rm: (target) => fsp.rm(target, { recursive: true, force: true }),
	hold: async () => ({ close: async () => {} }),
};

/** Durable media under one root directory: a medium is a directory holding one SQLite store file. */
export interface BunSqliteMedia {
	createMedium(): Promise<string>;
	/** A store instance on `medium`. Instances on one medium share its durable state. */
	open(medium: string, options?: DurableStoreOptions): Promise<DurableStore>;
	/** Closes every store opened on `medium` (an abandoned or killed instance included), then removes it. */
	deleteMedium(medium: string): Promise<void>;
	close(): Promise<void>;
}

interface Connection {
	readonly db: Database;
	readonly held: HeldFile;
}

const STORE_FILE = "store.sqlite";

export function createBunSqliteMedia(root: string, fs: MediaFileSystem = NATIVE_FILE_SYSTEM): BunSqliteMedia {
	const connections = new Map<string, Connection[]>();

	const closeAll = async (key: string): Promise<void> => {
		for (const connection of connections.get(key) ?? []) {
			connection.db.close(false);
			await connection.held.close();
		}
		connections.delete(key);
	};

	return {
		async createMedium() {
			const medium = fs.join(root, crypto.randomUUID());
			await fs.mkdir(medium);
			return medium;
		},

		async open(medium, options) {
			const key = await fs.resolve(medium);
			const file = fs.join(medium, STORE_FILE);
			const { store, db } = openSqliteStore(await fs.resolve(file), options);
			const held = await fs.hold(file);
			connections.set(key, [...(connections.get(key) ?? []), { db, held }]);
			return store;
		},

		async deleteMedium(medium) {
			await closeAll(await fs.resolve(medium));
			await fs.rm(medium);
		},

		async close() {
			for (const key of [...connections.keys()]) await closeAll(key);
		},
	};
}
