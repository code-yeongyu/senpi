declare module "bun:sqlite" {
	export class Database {
		constructor(filename: string, options?: { readonly create?: boolean });
		exec(sql: string): unknown;
		close(force?: boolean): void;
	}
}
