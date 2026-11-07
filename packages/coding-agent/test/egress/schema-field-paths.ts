type SchemaNode = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is SchemaNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigValue(node: SchemaNode): boolean {
	const branches = node.anyOf;
	return (
		Array.isArray(branches) &&
		branches.some((branch) => isNode(branch) && branch.type === "string") &&
		JSON.stringify(node).includes('"$file"')
	);
}

/**
 * Every field path a TypeBox object schema accepts, in the grammar of `MODELS_JSON_FIELD_CLASSES`:
 * `.` nests, `[]` is an array item, `.{key}` a record key, `.*` a record value. A config value
 * (string or `$file`/`$env`/`$concat` reference) is one leaf.
 */
export function schemaFieldPaths(schema: unknown): string[] {
	const paths = new Set<string>();
	const walk = (node: unknown, path: string): void => {
		if (!isNode(node)) return;
		if (isConfigValue(node)) {
			paths.add(path);
			return;
		}
		if (Array.isArray(node.anyOf)) {
			const nested = node.anyOf.filter((branch) => isNode(branch) && (branch.type === "object" || branch.anyOf));
			if (nested.length < node.anyOf.length) paths.add(path);
			for (const branch of nested) walk(branch, path);
			return;
		}
		if (node.type === "array") {
			walk(node.items, `${path}[]`);
			return;
		}
		if (node.type !== "object") {
			paths.add(path);
			return;
		}
		const properties = isNode(node.properties) ? Object.entries(node.properties) : [];
		for (const [name, child] of properties) walk(child, path ? `${path}.${name}` : name);
		const records = isNode(node.patternProperties) ? Object.values(node.patternProperties) : [];
		for (const child of records) {
			paths.add(`${path}.{key}`);
			walk(child, `${path}.*`);
		}
		if (properties.length === 0 && records.length === 0) paths.add(path);
	};
	walk(schema, "");
	return [...paths].sort();
}
