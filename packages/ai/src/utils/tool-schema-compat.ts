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

function mergeRootObjectUnion(schema: Record<string, unknown>): Record<string, unknown> | undefined {
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (branches === undefined || branches.length === 0) return undefined;

	const objectBranches: Record<string, unknown>[] = [];
	for (const branch of branches) {
		if (!isJsonObject(branch) || branch.type !== "object") return undefined;
		if (branch.properties !== undefined && !isJsonObject(branch.properties)) return undefined;
		if (branch.required !== undefined && !Array.isArray(branch.required)) return undefined;
		objectBranches.push(branch);
	}

	const properties: Record<string, unknown> = {};
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

	const firstRequired = objectBranches[0]?.required;
	let commonRequired = Array.isArray(firstRequired)
		? firstRequired.filter((name): name is string => typeof name === "string")
		: [];
	for (const branch of objectBranches.slice(1)) {
		const branchRequired = new Set(
			Array.isArray(branch.required)
				? branch.required.filter((name): name is string => typeof name === "string")
				: [],
		);
		commonRequired = commonRequired.filter((name) => branchRequired.has(name));
	}

	const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
	return {
		...rest,
		type: "object",
		properties,
		...(commonRequired.length > 0 ? { required: commonRequired } : {}),
	};
}

function normalizeNode(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map((child) => normalizeNode(child));
	}

	if (!isJsonObject(node)) {
		return node;
	}

	const hasCombiner = COMBINER_KEYS.some((key) => Array.isArray(node[key]));
	if (hasCombiner) {
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
	return normalizeNode(structuredClone(schema)) as Record<string, unknown>;
}

/**
 * Moonshot-flavored JSON Schema subset: in addition to the OpenAI-compatible
 * normalization, drop non-structural annotation keywords that Moonshot rejects.
 */
export function normalizeToolParametersForMoonshot(schema: Record<string, unknown>): Record<string, unknown> {
	const normalized = normalizeToolParametersForOpenAICompat(schema);
	return stripMoonshotAnnotations(mergeRootObjectUnion(normalized) ?? normalized);
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
