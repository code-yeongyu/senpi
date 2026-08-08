/**
 * JSON Schema normalization for tool parameters sent to OpenAI-compatible
 * backends. Some gateways (e.g. Apitopia → Kimi / Moonshot) enforce a stricter
 * subset that rejects a sibling `type` keyword on schemas that also declare
 * `anyOf` / `oneOf` / `allOf`. This helper removes that redundancy while
 * preserving the schema's semantics.
 */

export type ToolSchemaFlavor = "moonshot-mfjs";

const COMBINER_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SCHEMA_SINGLE_KEYS = [
	"items",
	"additionalProperties",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
] as const;

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalarType(type: unknown): type is "string" | "number" | "integer" | "boolean" {
	return type === "string" || type === "number" || type === "integer" || type === "boolean";
}

/**
 * Move a parent-level `type` keyword into combiner branches that do not already
 * declare one, then drop the parent `type`. This keeps the schema equivalent
 * while satisfying validators that require `type` to live inside each branch.
 */
function moveTypeIntoCombinerBranches(node: Record<string, unknown>): void {
	if (!("type" in node)) return;

	const parentType = node.type;
	for (const combiner of COMBINER_KEYS) {
		const branches = node[combiner];
		if (!Array.isArray(branches)) continue;

		for (const branch of branches) {
			if (isJsonObject(branch) && !("type" in branch)) {
				branch.type = parentType;
			}
		}
	}

	delete node.type;
}

/**
 * Collapse a homogeneous all-`const` union into a typed `enum`. This is the
 * wire shape many OpenAI-compatible gateways expect for literal unions.
 */
function collapseConstUnion(node: Record<string, unknown>): void {
	const branches = node.anyOf;
	if (!Array.isArray(branches) || branches.length < 2) return;
	if ("type" in node) return;

	const values: unknown[] = [];
	let sharedType: string | undefined;

	for (const branch of branches) {
		if (!isJsonObject(branch)) return;
		if (!Object.hasOwn(branch, "const")) return;

		const keys = Object.keys(branch);
		if (keys.length !== 2 || !keys.includes("type")) return;

		const branchType = branch.type;
		if (!isScalarType(branchType)) return;

		if (sharedType === undefined) {
			sharedType = branchType;
		} else if (sharedType !== branchType) {
			return;
		}

		values.push(branch.const);
	}

	if (sharedType === undefined || values.length === 0) return;

	delete node.anyOf;
	node.type = sharedType;
	node.enum = values;
}

/**
 * Collapse a root-level object union into one object schema.
 *
 * A tool's root parameters schema must be a plain `{"type":"object"}` schema:
 * OpenAI-compatible gateways reject a root that only carries `anyOf`/`oneOf`
 * with `tools.function.parameters.type is required and must be "object"`. The
 * merge is intentionally lossy in the direction of permissiveness — branch
 * exclusivity becomes advisory — but it must never lose a declared parameter,
 * so the root's own `properties` and `required` are merged with the branches'
 * rather than replaced by them.
 */
function mergeRootObjectUnion(schema: Record<string, unknown>): Record<string, unknown> | undefined {
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (branches === undefined || branches.length === 0) return undefined;
	if (schema.properties !== undefined && !isJsonObject(schema.properties)) return undefined;
	if (schema.required !== undefined && !Array.isArray(schema.required)) return undefined;

	const objectBranches: Record<string, unknown>[] = [];
	for (const branch of branches) {
		// An untyped branch is a constraint-only variant (e.g. `{ required: [...] }`)
		// over the root's own properties, so it merges like an object branch.
		if (!isJsonObject(branch) || (branch.type !== "object" && branch.type !== undefined)) return undefined;
		if (branch.properties !== undefined && !isJsonObject(branch.properties)) return undefined;
		if (branch.required !== undefined && !Array.isArray(branch.required)) return undefined;
		objectBranches.push(branch);
	}

	const properties: Record<string, unknown> = isJsonObject(schema.properties) ? { ...schema.properties } : {};
	for (const branch of objectBranches) {
		if (!isJsonObject(branch.properties)) continue;
		for (const [name, propertySchema] of Object.entries(branch.properties)) {
			const existing = properties[name];
			properties[name] =
				existing === undefined || JSON.stringify(existing) === JSON.stringify(propertySchema)
					? propertySchema
					: { anyOf: [existing, propertySchema] };
		}
	}

	// Only names required by EVERY branch stay required; a name required by one
	// branch alone would reject payloads the union accepts. Root-level `required`
	// applies to all branches, so it is unioned back in.
	const rootRequired = Array.isArray(schema.required)
		? schema.required.filter((name): name is string => typeof name === "string")
		: [];
	const branchRequiredSets = objectBranches.map(
		(branch) =>
			new Set(
				Array.isArray(branch.required)
					? branch.required.filter((name): name is string => typeof name === "string")
					: [],
			),
	);
	const firstBranchRequired = branchRequiredSets[0];
	const commonBranchRequired = firstBranchRequired
		? [...firstBranchRequired].filter((name) => branchRequiredSets.every((names) => names.has(name)))
		: [];
	const required = [...new Set([...rootRequired, ...commonBranchRequired])];

	const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
	return {
		...rest,
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

function normalizeNode(node: unknown, isRoot = false): unknown {
	if (Array.isArray(node)) {
		return node.map((child) => normalizeNode(child));
	}

	if (!isJsonObject(node)) {
		return node;
	}

	delete node.optional;

	const hasCombiner = COMBINER_KEYS.some((key) => Array.isArray(node[key]));
	// The root of a tool's parameters must keep `type: "object"`; hoisting it into
	// the branches leaves a typeless root that gateways reject outright.
	if (hasCombiner && !isRoot) {
		moveTypeIntoCombinerBranches(node);
	}

	for (const combiner of COMBINER_KEYS) {
		const branches = node[combiner];
		if (Array.isArray(branches)) {
			node[combiner] = branches.map((branch) => normalizeNode(branch));
		}
	}

	if (Array.isArray(node.anyOf)) {
		collapseConstUnion(node);
	}

	for (const key of SCHEMA_SINGLE_KEYS) {
		if (Object.hasOwn(node, key)) {
			node[key] = normalizeNode(node[key]);
		}
	}

	for (const key of SCHEMA_MAP_KEYS) {
		const map = node[key];
		if (!isJsonObject(map)) continue;
		for (const name of Object.keys(map)) {
			map[name] = normalizeNode(map[name]);
		}
	}

	return node;
}

/**
 * Return a deep-normalized copy of a tool's JSON Schema parameters, suitable
 * for OpenAI-compatible Chat Completions backends.
 */
export function normalizeToolParametersForOpenAICompat(schema: Record<string, unknown>): Record<string, unknown> {
	const normalized = normalizeNode(structuredClone(schema), true) as Record<string, unknown>;
	return ensureRootObjectSchema(normalized);
}

/**
 * Guarantee the wire shape every OpenAI-compatible backend requires for tool
 * parameters: a root object schema. A root union of object shapes is merged into
 * one object schema; a root that merely lost its `type` gets it restored.
 *
 * A root whose branches are not object shapes is left alone: forcing
 * `type: "object"` onto a scalar union would assert something the schema
 * contradicts, which is worse than the missing keyword. Tool parameters are
 * objects in practice, so this only guards against corrupting an exotic schema.
 */
function ensureRootObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const merged = mergeRootObjectUnion(schema);
	if (merged) return merged;
	if (schema.type !== undefined) return schema;
	const hasCombiner = COMBINER_KEYS.some((key) => Array.isArray(schema[key]));
	if (hasCombiner) return schema;
	return { ...schema, type: "object" };
}

/**
 * Moonshot-flavored JSON Schema subset: in addition to the OpenAI-compatible
 * normalization, drop non-structural annotation keywords that Moonshot rejects.
 */
export function normalizeToolParametersForMoonshot(schema: Record<string, unknown>): Record<string, unknown> {
	return stripMoonshotAnnotations(normalizeToolParametersForOpenAICompat(schema));
}

/**
 * Resolve a tool's root parameters into a single object schema, without the
 * OpenAI-specific rewrites. Wire formats that read a tool's parameters from
 * top-level `properties`/`required` need this: a root union carries neither, so
 * they would otherwise describe the tool to the model as taking no arguments.
 * Schemas that are already plain objects are returned untouched.
 */
export function resolveRootObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return mergeRootObjectUnion(structuredClone(schema)) ?? schema;
}

function stripMoonshotAnnotations(node: unknown): Record<string, unknown> {
	if (Array.isArray(node)) {
		return node.map((child) => stripMoonshotAnnotations(child)) as unknown as Record<string, unknown>;
	}

	if (!isJsonObject(node)) {
		return node as Record<string, unknown>;
	}

	// Moonshot does not support JSON Schema validators like `format` or
	// annotation-only keywords like `examples` inside function parameters.
	delete node.format;
	delete node.examples;
	delete node.readOnly;
	delete node.writeOnly;
	delete node.deprecated;
	delete node.$schema;
	delete node.$id;

	for (const combiner of COMBINER_KEYS) {
		const branches = node[combiner];
		if (Array.isArray(branches)) {
			node[combiner] = branches.map((branch) => stripMoonshotAnnotations(branch));
		}
	}

	for (const key of SCHEMA_SINGLE_KEYS) {
		if (Object.hasOwn(node, key)) {
			node[key] = stripMoonshotAnnotations(node[key]);
		}
	}

	for (const key of SCHEMA_MAP_KEYS) {
		const map = node[key];
		if (!isJsonObject(map)) continue;
		for (const name of Object.keys(map)) {
			map[name] = stripMoonshotAnnotations(map[name]);
		}
	}

	return node;
}
