import type { TSchema } from "typebox";

export interface ToolArgumentValidationError {
	readonly instancePath: string;
	readonly keyword: string;
	readonly message?: string;
	readonly params: {
		readonly [key: string]: unknown;
		readonly missingProperty?: string;
		readonly requiredProperties?: string[];
	};
}

interface ToolArgumentValidator {
	(value: unknown): boolean;
	errors?: readonly ToolArgumentValidationError[] | null;
}

const validators = new WeakMap<TSchema, ToolArgumentValidator>();

/** A protocol may own validation without permitting local argument coercion. */
export function registerToolArgumentValidator(schema: TSchema, validate: ToolArgumentValidator): void {
	validators.set(schema, validate);
}

export function getToolArgumentValidator(schema: TSchema): ToolArgumentValidator | undefined {
	return validators.get(schema);
}
