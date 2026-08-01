import type {
	SessionForkSelection,
	SessionReader,
	SessionStore,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	createSessionId,
	getFileSystemResultOrThrow,
	readSessionEntriesForFork,
	SessionError,
} from "@earendil-works/pi-agent-core";
import { applyMigrations } from "./migrations.ts";
import { SqliteSessionConnection } from "./storage/index.ts";
import { rowToMetadata, type SessionRow } from "./storage/sessions.ts";
import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteSessionCreateOptions,
	SqliteSessionListOptions,
	SqliteSessionMetadata,
	SqliteSessionStoreEnv,
} from "./types.ts";

function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

async function configureSqliteDatabase(db: SqliteDatabase): Promise<void> {
	await db.exec("PRAGMA journal_mode=WAL");
	await db.exec("PRAGMA synchronous=FULL");
	await db.exec("PRAGMA busy_timeout=5000");
}

export type SqliteSessionStoreOptions = {
	env: SqliteSessionStoreEnv;
	sqlite: SqliteDatabaseFactory;
	databasePath: string;
};

class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async drain(): Promise<void> {
		await this.tail;
	}
}

class SqliteSessionStore
	implements SessionStore<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions>
{
	private readonly env: SqliteSessionStoreEnv;
	private readonly sqlite: SqliteDatabaseFactory;
	private readonly databasePathInput: string;
	private databasePath: string | undefined;
	private databasePromise: Promise<SqliteDatabase> | undefined;
	private database: SqliteDatabase | undefined;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private readonly operations = new SerialOperationQueue();
	private readonly writers = new Map<string, SqliteSessionConnection>();

	constructor(options: SqliteSessionStoreOptions) {
		this.env = options.env;
		this.sqlite = options.sqlite;
		this.databasePathInput = options.databasePath;
	}

	create(options: SqliteSessionCreateOptions): Promise<SessionReader<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const path = await this.getDatabasePath();
			const connection = await db.transaction(() =>
				SqliteSessionConnection.create(db, path, {
					cwd: options.cwd,
					sessionId: options.id ?? createSessionId(),
					parentSessionId: options.parentSessionId,
					metadata: options.metadata,
				}),
			);
			const metadata = connection.metadata;
			this.writers.set(metadata.id, connection);
			return this.reader(connection);
		});
	}

	load(metadata: SqliteSessionMetadata): Promise<SessionReader<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(() => this.loadSession(metadata));
	}

	private async loadSession(metadata: SqliteSessionMetadata): Promise<SessionReader<SqliteSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.env.exists(metadata.path), `Failed to check database ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const connection =
			this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
		this.writers.set(metadata.id, connection);
		return this.reader(connection);
	}

	list(options: SqliteSessionListOptions = {}): Promise<SqliteSessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueue(() => this.listSessions(options));
	}

	private async listSessions(options: SqliteSessionListOptions): Promise<SqliteSessionMetadata[]> {
		const path = await this.getDatabasePath();
		if (!getFileSystemResultOrThrow(await this.env.exists(path), `Failed to check database ${path}`)) return [];
		const db = await this.getDatabase();
		const rows = options.cwd
			? await db
					.prepare(
						"SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions WHERE cwd = ? ORDER BY created_at DESC",
					)
					.all<SessionRow>(options.cwd)
			: await db
					.prepare(
						"SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions ORDER BY created_at DESC",
					)
					.all<SessionRow>();
		return rows.map((row) => rowToMetadata(row, path));
	}

	appendEntry(metadata: SqliteSessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const connection =
				this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
			this.writers.set(metadata.id, connection);
			await connection.appendEntry(entry);
		});
	}

	delete(metadata: SqliteSessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			await db.transaction(async () => {
				await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM entry_materialized WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_materialized WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_sequences WHERE session_id = ?").run(metadata.id);
				const result = await db.prepare("DELETE FROM sessions WHERE id = ?").run(metadata.id);
				if (result.changes === 0) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
			});
			this.writers.delete(metadata.id);
		});
	}

	fork(
		source: SqliteSessionMetadata,
		options: SqliteSessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionReader<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const connection = await db.transaction(async () => {
				const sourceConnection = this.writers.get(source.id) ?? (await SqliteSessionConnection.open(db, source));
				this.writers.set(source.id, sourceConnection);
				const entries = await readSessionEntriesForFork(sourceConnection, selection);
				const connection = await SqliteSessionConnection.create(db, await this.getDatabasePath(), {
					cwd: options.cwd,
					sessionId: options.id ?? createSessionId(),
					parentSessionId: options.parentSessionId ?? source.id,
					metadata: options.metadata ?? source.metadata,
				});
				for (const entry of entries) await connection.appendEntry(entry, { transaction: false });
				return connection;
			});
			const metadata = connection.metadata;
			this.writers.set(metadata.id, connection);
			return this.reader(connection);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.finishDisposal();
		}
		await this.disposePromise;
	}

	private async finishDisposal(): Promise<void> {
		await this.operations.drain();
		const db = this.database ?? (this.databasePromise ? await this.databasePromise : undefined);
		this.database = undefined;
		this.databasePromise = undefined;
		this.writers.clear();
		if (db) await db.close();
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "SQLite session store is disposed");
	}

	private reader(connection: SqliteSessionConnection): SessionReader<SqliteSessionMetadata> {
		return {
			metadata: connection.metadata,
			readHead: () => {
				this.assertOpen();
				return this.operations.enqueue(() => connection.readHead());
			},
			readEntry: (id) => {
				this.assertOpen();
				return this.operations.enqueue(() => connection.readEntry(id));
			},
			readEntries: (options) => {
				this.assertOpen();
				return this.operations.enqueue(() => connection.readEntries(options));
			},
			readPathToRootOrCompaction: (leafId) => {
				this.assertOpen();
				return this.operations.enqueue(() => connection.readPathToRootOrCompaction(leafId));
			},
		};
	}

	private async getDatabasePath(): Promise<string> {
		this.databasePath ??= getFileSystemResultOrThrow(
			await this.env.absolutePath(this.databasePathInput),
			`Failed to resolve SQLite sessions database ${this.databasePathInput}`,
		);
		return this.databasePath;
	}

	private async getDatabase(): Promise<SqliteDatabase> {
		if (!this.databasePromise) this.databasePromise = this.openDatabase();
		this.database = await this.databasePromise;
		return this.database;
	}

	private async openDatabase(): Promise<SqliteDatabase> {
		const path = await this.getDatabasePath();
		const directory = getParentPath(path);
		getFileSystemResultOrThrow(
			await this.env.createDir(directory, { recursive: true }),
			`Failed to create SQLite sessions directory ${directory}`,
		);
		const db = await this.sqlite.open(path);
		try {
			await configureSqliteDatabase(db);
			await applyMigrations(db);
			return db;
		} catch (error) {
			await db.close();
			throw error;
		}
	}
}

export function createSqliteSessionStore(
	options: SqliteSessionStoreOptions,
): SessionStore<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions> {
	return new SqliteSessionStore(options);
}
