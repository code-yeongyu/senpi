// The repository type-checks with `types: ["node"]` and installs no Bun type package. `bun:sqlite`'s `Database` class
// is declared once, in packages/coding-agent/src/modes/rpc/bun-sqlite.d.ts; this file merges in the part of Bun 1.4's
// API this package uses (queries and transactions).
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

	interface Database {
		query<Row = unknown>(sql: string): Statement<Row>;
		transaction<Result>(body: () => Result): Transaction<Result>;
	}
}
