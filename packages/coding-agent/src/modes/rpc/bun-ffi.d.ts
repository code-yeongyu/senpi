declare module "bun:ffi" {
	export enum FFIType {
		i32 = 5,
		u32 = 6,
		ptr = 12,
	}
	export function ptr(view: NodeJS.TypedArray): number;
	export function dlopen<Symbols extends Record<string, { args: readonly FFIType[]; returns: FFIType }>>(
		library: string,
		symbols: Symbols,
	): { symbols: { [Name in keyof Symbols]: (...args: number[]) => number } };
}
