declare module "bun:sqlite" {
	export class Database {
		constructor(filename: string, options?: { readonly create?: boolean });
		exec(sql: string): unknown;
		prepare(sql: string): {
			run(...params: unknown[]): unknown;
			get(...params: unknown[]): unknown;
			all(...params: unknown[]): unknown[];
		};
		close(force?: boolean): void;
	}
}
