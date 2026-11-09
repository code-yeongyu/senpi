// The repository type-checks with `types: ["node"]` and installs no Bun type package, so this file is the
// single source for the `bun:sqlite` declaration the workspace uses: the `Database` class is declared
// exactly once, here, with the full surface the workspace uses (construction, exec/close, prepare,
// queries and transactions). It used to be split: `packages/coding-agent/src/modes/rpc/bun-sqlite.d.ts` held the
// class while this file only merged in the query/transaction members. A standalone consumer of this
// package never loaded that file, so `new Database(...)` had no value declaration outside the
// workspace (senpi#5996). `src/index.ts` references this file so the declaration ships with the
// package entry point.
declare module "bun:sqlite" {
	type Binding = string | number | bigint | boolean | null | Uint8Array;

	export interface Statement<Row> {
		all(...params: Binding[]): Row[];
		get(...params: Binding[]): Row | null;
		run(...params: Binding[]): { changes: number; lastInsertRowid: number | bigint };
	}

	interface Transaction<Result> {
		(): Result;
		deferred(): Result;
		immediate(): Result;
	}

	export class Database {
		constructor(filename: string, options?: { readonly create?: boolean });
		exec(sql: string): unknown;
		prepare(sql: string): {
			run(...params: unknown[]): unknown;
			get(...params: unknown[]): unknown;
			all(...params: unknown[]): unknown[];
		};
		close(force?: boolean): void;
		query<Row = unknown>(sql: string): Statement<Row>;
		transaction<Result>(body: () => Result): Transaction<Result>;
	}
}
