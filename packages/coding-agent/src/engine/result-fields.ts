/**
 * The free fields of an answer, as dotted paths: every non-literal string, every `unknown`, every index
 * signature. A literal union, a number or a boolean names nothing a caller supplied; these can.
 * `[]` marks an array element, `{}` a key of an index signature. Streams and processes are opaque handles.
 */
type Opaque =
	| Promise<unknown>
	| AbortSignal
	| ((...args: never[]) => unknown)
	| NodeJS.ReadableStream
	| NodeJS.WritableStream;
type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7];

type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;

/** Every key path of an answer, whatever its type: what the forbidden-name check reads. */
export type FieldPaths<T, P extends string = "", D extends number = 7> = [D] extends [never]
	? never
	: unknown extends T
		? never
		: T extends Opaque
			? never
			: T extends readonly (infer E)[]
				? FieldPaths<E, Join<P, "[]">, Depth[D]>
				: T extends object
					? string extends keyof T
						? FieldPaths<T[string], Join<P, "{}">, Depth[D]>
						: {
								[K in keyof T & string]-?:
									| Join<P, K>
									| FieldPaths<Exclude<T[K], undefined>, Join<P, K>, Depth[D]>;
							}[keyof T & string]
					: never;

type IsFreeString<T> = T extends string ? (string extends T ? true : false) : false;

export type FreeFieldPaths<T, P extends string = "", D extends number = 7> = [D] extends [never]
	? never
	: unknown extends T
		? P
		: T extends Opaque
			? never
			: true extends IsFreeString<T>
				? P
				: T extends readonly (infer E)[]
					? FreeFieldPaths<E, Join<P, "[]">, Depth[D]>
					: T extends object
						? string extends keyof T
							? P | FreeFieldPaths<T[string], Join<P, "{}">, Depth[D]>
							: {
									[K in keyof T & string]-?: FreeFieldPaths<Exclude<T[K], undefined>, Join<P, K>, Depth[D]>;
								}[keyof T & string]
						: never;
