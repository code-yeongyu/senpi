import type { TextContent, Tool } from "../../types.js";
import type { ParsedToolCall, StreamParser, StreamParserEvent } from "../types.js";

const INDENT = "   ";

/**
 * Formats tools as an XML-style system prompt for MorphXml protocol.
 * Ported from ai-sdk-tool-call-middleware morph-xml-prompt.ts
 */
export function morphXmlFormatToolsSystemPrompt(tools: Tool[]): string {
	const toolsText = renderToolsForXmlPrompt(tools);

	const header = `# Tools
You may call one or more functions to assist with the user query.`;

	const definitions = ["You have access to the following functions:", "<tools>", toolsText, "</tools>"].join("\n");

	const rules = `<rules>
- Use exactly one XML element whose tag name is the function name.
- Put each parameter as a child element.
- Values must follow the schema exactly (numbers, arrays, objects, enums -> copy as-is).
- Do not add or remove functions or parameters.
- Each required parameter must appear once.
- Output nothing before or after the function call.
- It is also possible to call multiple types of functions in one turn or to call a single function multiple times.
</rules>`;

	const examples = `For each function call, output the function name and parameter in the following format:
<example_function_name>
   <example_parameter_1>value_1</example_parameter_1>
   <example_parameter_2>This is the value for the second parameter
that can span
multiple lines</example_parameter_2>
</example_function_name>`;

	return [header, definitions, rules, examples].filter((section) => section.trim().length > 0).join("\n\n");
}

function renderToolsForXmlPrompt(tools: Tool[]): string {
	if (!tools.length) {
		return "none";
	}

	return tools.map(renderToolForXmlPrompt).join("\n\n");
}

function renderToolForXmlPrompt(tool: Tool): string {
	const lines: string[] = [`name: ${tool.name}`];

	if (tool.description) {
		lines.push(`description: ${tool.description}`);
	}

	lines.push("parameters:");
	const normalizedSchema = normalizeSchema(tool.parameters);
	lines.push(...renderParametersSummary(normalizedSchema, 1));
	lines.push(`schema: ${stringifySchema(normalizedSchema)}`);

	return lines.join("\n");
}

function normalizeSchema(
	schema: Record<string, unknown> | boolean | string | undefined,
): Record<string, unknown> | boolean | undefined {
	if (typeof schema === "string") {
		try {
			return JSON.parse(schema) as Record<string, unknown>;
		} catch {
			return { type: "string", const: schema };
		}
	}

	return schema;
}

function renderParametersSummary(schema: Record<string, unknown> | boolean | undefined, indentLevel: number): string[] {
	const indent = INDENT.repeat(indentLevel);

	if (schema === undefined || schema === null) {
		return [`${indent}(none)`];
	}

	if (schema === true) {
		return [`${indent}(any)`];
	}

	if (schema === false) {
		return [`${indent}(no valid parameters)`];
	}

	if (typeof schema !== "object") {
		return [`${indent}- value (${String(schema)})`];
	}

	const schemaObj = schema as Record<string, unknown>;
	const schemaType = schemaObj.type;
	const schemaTypeArray: string[] = [];

	if (Array.isArray(schemaType)) {
		schemaTypeArray.push(...schemaType);
	} else if (typeof schemaType === "string") {
		schemaTypeArray.push(schemaType);
	}

	const isObjectLike = schemaTypeArray.includes("object") || !!schemaObj.properties;

	if (isObjectLike) {
		const properties = (schemaObj.properties ?? {}) as Record<string, Record<string, unknown> | boolean>;
		const requiredSet = new Set(Array.isArray(schemaObj.required) ? schemaObj.required : []);
		const propertyNames = Object.keys(properties).sort();

		if (propertyNames.length === 0) {
			return [`${indent}(no named parameters)`];
		}

		const lines: string[] = [];
		for (const propName of propertyNames) {
			const propSchema = properties[propName];
			lines.push(
				renderPropertySummaryLine({
					indent,
					propName,
					propSchema,
					required: requiredSet.has(propName),
				}),
			);
		}

		return lines.length ? lines : [`${indent}(no parameters)`];
	}

	return [`${indent}- value (${summarizeType(schemaObj)})`];
}

function renderPropertySummaryLine({
	indent,
	propName,
	propSchema,
	required,
}: {
	indent: string;
	propName: string;
	propSchema: Record<string, unknown> | boolean | undefined;
	required: boolean;
}): string {
	const typeLabel = summarizeType(propSchema);
	const requiredLabel = required ? "required" : "optional";
	const extras = collectPropertyExtras(propSchema);
	const extraText = extras.length ? ` - ${extras.join("; ")}` : "";

	return `${indent}- ${propName} (${typeLabel}, ${requiredLabel})${extraText}`;
}

function collectPropertyExtras(propSchema: Record<string, unknown> | boolean | undefined): string[] {
	if (!propSchema || typeof propSchema !== "object") {
		return [];
	}

	const extras: string[] = [];
	const schema = propSchema as Record<string, unknown>;

	if (schema.enum && Array.isArray(schema.enum)) {
		extras.push(`enum: ${formatValue(schema.enum)}`);
	}

	if (schema.default !== undefined) {
		extras.push(`default: ${formatValue(schema.default)}`);
	}

	if (typeof schema.description === "string") {
		extras.push(schema.description);
	}

	return extras;
}

function summarizeType(schema: Record<string, unknown> | boolean | undefined): string {
	if (schema === undefined || schema === null) {
		return "unknown";
	}

	if (schema === true) {
		return "any";
	}

	if (schema === false) {
		return "never";
	}

	if (typeof schema !== "object") {
		return String(schema);
	}

	const schemaType = schema.type;
	let baseType = "";

	if (Array.isArray(schemaType) && schemaType.length) {
		baseType = schemaType.join(" | ");
	} else if (typeof schemaType === "string") {
		baseType = schemaType;
	} else if (schema.enum && Array.isArray(schema.enum)) {
		const inferred: string[] = Array.from(new Set(schema.enum.map((value: unknown) => typeof value)));
		if (inferred.length === 1 && inferred[0]) {
			baseType = inferred[0];
		}
	} else if (schema.const !== undefined) {
		baseType = typeof schema.const;
	}

	if (!baseType) {
		baseType = "any";
	}

	if (baseType === "array" && schema.items) {
		const itemType = Array.isArray(schema.items)
			? schema.items.map((item: Record<string, unknown> | boolean) => summarizeType(item)).join(" | ")
			: summarizeType(schema.items as Record<string, unknown>);
		return `array<${itemType}>`;
	}

	if (baseType === "string" && typeof schema.format === "string") {
		return `string (${schema.format})`;
	}

	return baseType;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (value === null) {
		return "null";
	}

	if (Array.isArray(value)) {
		return `[${value.map(formatValue).join(", ")}]`;
	}

	return JSON.stringify(value);
}

function stringifySchema(schema: Record<string, unknown> | boolean | undefined): string {
	if (schema === undefined) {
		return "null";
	}

	return JSON.stringify(stripSchemaKeys(schema));
}

function stripSchemaKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => stripSchemaKeys(entry));
	}

	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const cleaned: Record<string, unknown> = {};

		for (const [key, entry] of Object.entries(record)) {
			if (key === "$schema") {
				continue;
			}
			cleaned[key] = stripSchemaKeys(entry);
		}

		return cleaned;
	}

	return value;
}

export function morphXmlFormatToolResponse(toolName: string, _toolCallId: string, content: TextContent[]): string {
	const combinedText = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	let resultValue: unknown = combinedText;
	try {
		resultValue = JSON.parse(combinedText);
	} catch {}

	const resultLines = formatXmlNode("result", resultValue, 1);

	return [
		"<tool_response>",
		`   <tool_name>${escapeXml(toolName)}</tool_name>`,
		...resultLines,
		"</tool_response>",
	].join("\n");
}

/**
 * Formats a tool call as XML for MorphXml protocol.
 */
export function morphXmlFormatToolCall(name: string, args: Record<string, unknown>): string {
	const lines = formatXmlNode(name, args, 0);
	return lines.join("\n");
}

type JsonSchema = Record<string, unknown> | boolean | undefined;

type XmlNode = {
	name: string;
	children: XmlNode[];
	textSegments: string[];
};

type StreamToolState = {
	id: string;
	index: number;
	lastArgumentsSnapshot: string | null;
	name: string;
	schema: JsonSchema;
};

export function parseMorphXmlGeneratedText(text: string, tools: Tool[]): ParsedToolCall[] {
	if (tools.length === 0 || text.length === 0) {
		return [];
	}

	const toolSchemaMap = createToolSchemaMap(tools);
	const toolNamesPattern = tools.map((tool) => escapeRegExp(tool.name)).join("|");
	const toolCallPattern = new RegExp(`<\\s*(${toolNamesPattern})\\s*>([\\s\\S]*?)<\\/\\s*\\1\\s*>`, "g");
	const parsedToolCalls: ParsedToolCall[] = [];

	for (const match of text.matchAll(toolCallPattern)) {
		const toolName = match[1];
		const toolBody = match[2] ?? "";
		if (!toolName) {
			continue;
		}

		parsedToolCalls.push({
			name: toolName,
			arguments: parseMorphXmlArguments(toolBody, toolSchemaMap.get(toolName)),
		});
	}

	return parsedToolCalls;
}

export function createMorphXmlStreamParser(tools: Tool[]): StreamParser {
	const toolSchemaMap = createToolSchemaMap(tools);
	const toolNames = tools.map((tool) => tool.name);

	let buffer = "";
	let nextToolCallIndex = 0;
	let currentToolState: StreamToolState | null = null;

	function emitArgumentsSnapshot(
		events: StreamParserEvent[],
		toolState: StreamToolState,
		argumentsRecord: Record<string, unknown>,
	): void {
		const argumentsSnapshot = JSON.stringify(argumentsRecord);
		if (argumentsSnapshot === toolState.lastArgumentsSnapshot || argumentsSnapshot === "{}") {
			return;
		}

		toolState.lastArgumentsSnapshot = argumentsSnapshot;
		events.push({
			type: "toolcall_delta",
			index: toolState.index,
			argumentsDelta: argumentsSnapshot,
		});
	}

	function processBuffer(): StreamParserEvent[] {
		const events: StreamParserEvent[] = [];

		while (buffer.length > 0) {
			if (currentToolState) {
				const closingTagPattern = new RegExp(`</\\s*${escapeRegExp(currentToolState.name)}\\s*>`);
				const closingTagMatch = closingTagPattern.exec(buffer);

				if (!closingTagMatch || closingTagMatch.index === undefined) {
					emitArgumentsSnapshot(
						events,
						currentToolState,
						parseMorphXmlPartialArguments(buffer, currentToolState.schema),
					);
					break;
				}

				const toolBody = buffer.slice(0, closingTagMatch.index);
				emitArgumentsSnapshot(
					events,
					currentToolState,
					parseMorphXmlPartialArguments(toolBody, currentToolState.schema),
				);

				const parsedArguments = parseMorphXmlArguments(toolBody, currentToolState.schema);
				buffer = buffer.slice(closingTagMatch.index + closingTagMatch[0].length);
				events.push({
					type: "toolcall_end",
					index: currentToolState.index,
					name: currentToolState.name,
					id: currentToolState.id,
					arguments: parsedArguments,
				});
				currentToolState = null;
				continue;
			}

			const openingTag = findEarliestToolOpeningTag(buffer, toolNames);
			if (!openingTag) {
				const textLength = getSafeTextLength(buffer, toolNames);
				if (textLength === 0) {
					break;
				}

				events.push({ type: "text", text: buffer.slice(0, textLength) });
				buffer = buffer.slice(textLength);
				continue;
			}

			if (openingTag.index > 0) {
				events.push({ type: "text", text: buffer.slice(0, openingTag.index) });
			}

			buffer = buffer.slice(openingTag.index + openingTag.tag.length);
			currentToolState = {
				id: globalThis.crypto.randomUUID(),
				index: nextToolCallIndex,
				lastArgumentsSnapshot: null,
				name: openingTag.name,
				schema: toolSchemaMap.get(openingTag.name),
			};
			nextToolCallIndex += 1;
			events.push({
				type: "toolcall_start",
				index: currentToolState.index,
				name: currentToolState.name,
				id: currentToolState.id,
			});
		}

		return events;
	}

	return {
		feed(textDelta: string): StreamParserEvent[] {
			if (textDelta.length === 0) {
				return [];
			}

			buffer += textDelta;
			return processBuffer();
		},

		finish(): StreamParserEvent[] {
			const events = processBuffer();

			if (!currentToolState && buffer.length > 0) {
				events.push({ type: "text", text: buffer });
				buffer = "";
			}

			return events;
		},
	};
}

function formatXmlNode(tagName: string, value: unknown, depth: number): string[] {
	const indent = INDENT.repeat(depth);

	if (value === null || value === undefined) {
		return [`${indent}<${tagName}></${tagName}>`];
	}

	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		const escapedValue = typeof value === "string" ? escapeXml(value) : String(value);
		return [`${indent}<${tagName}>${escapedValue}</${tagName}>`];
	}

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return [`${indent}<${tagName}></${tagName}>`];
		}
		const lines = [`${indent}<${tagName}>`];
		for (const item of value) {
			lines.push(...formatXmlNode("item", item, depth + 1));
		}
		lines.push(`${indent}</${tagName}>`);
		return lines;
	}

	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) {
		return [`${indent}<${tagName}></${tagName}>`];
	}

	const lines = [`${indent}<${tagName}>`];
	for (const [key, entryValue] of entries) {
		lines.push(...formatXmlNode(key, entryValue, depth + 1));
	}
	lines.push(`${indent}</${tagName}>`);
	return lines;
}

function createToolSchemaMap(tools: Tool[]): Map<string, JsonSchema> {
	return new Map(tools.map((tool) => [tool.name, normalizeSchema(tool.parameters)]));
}

function parseMorphXmlArguments(toolBody: string, schema: JsonSchema): Record<string, unknown> {
	const parsedRoot = parseXmlRoot(`<root>${toolBody}</root>`);
	if (!parsedRoot) {
		return {};
	}

	return convertChildrenToObject(parsedRoot.children, schema);
}

function parseMorphXmlPartialArguments(toolBody: string, schema: JsonSchema): Record<string, unknown> {
	const partialArguments: Record<string, unknown> = {};
	const normalizedSchema = normalizeSchema(schema);
	let position = 0;

	while (position < toolBody.length) {
		const nextTagIndex = toolBody.indexOf("<", position);
		if (nextTagIndex === -1) {
			break;
		}

		if (toolBody.slice(position, nextTagIndex).trim().length > 0) {
			break;
		}

		const openingTag = parseOpeningTag(toolBody, nextTagIndex);
		if (!openingTag) {
			break;
		}

		const propertySchema = getPropertySchema(normalizedSchema, openingTag.name);
		const closingTag = `</${openingTag.name}>`;
		const closingTagIndex = toolBody.indexOf(closingTag, openingTag.endIndex);

		if (closingTagIndex === -1) {
			const partialValueText = toolBody.slice(openingTag.endIndex);
			if (partialValueText.includes("<")) {
				break;
			}

			partialArguments[openingTag.name] = coercePartialXmlValue(partialValueText, propertySchema);
			break;
		}

		const completeNode = parseXmlRoot(toolBody.slice(nextTagIndex, closingTagIndex + closingTag.length));
		if (!completeNode) {
			break;
		}

		partialArguments[openingTag.name] = convertXmlNodeValue(completeNode, propertySchema);
		position = closingTagIndex + closingTag.length;
	}

	return partialArguments;
}

function parseXmlRoot(xml: string): XmlNode | null {
	const tagPattern = /<\s*(\/)?\s*([A-Za-z_][\w.-]*)\s*(\/)?\s*>/g;
	const stack: XmlNode[] = [];
	let rootNode: XmlNode | null = null;
	let lastIndex = 0;

	for (const match of xml.matchAll(tagPattern)) {
		const fullMatch = match[0];
		const matchIndex = match.index;
		const isClosingTag = match[1] === "/";
		const tagName = match[2];
		const isSelfClosing = match[3] === "/";

		if (matchIndex === undefined || !fullMatch || !tagName) {
			continue;
		}

		const textContent = xml.slice(lastIndex, matchIndex);
		if (stack.length > 0 && textContent.length > 0) {
			stack[stack.length - 1]?.textSegments.push(textContent);
		} else if (stack.length === 0 && textContent.trim().length > 0) {
			return null;
		}

		if (isClosingTag) {
			const completedNode = stack.pop();
			if (!completedNode || completedNode.name !== tagName) {
				return null;
			}

			if (stack.length > 0) {
				stack[stack.length - 1]?.children.push(completedNode);
			} else if (!rootNode) {
				rootNode = completedNode;
			} else {
				return null;
			}
		} else {
			const node: XmlNode = {
				name: tagName,
				children: [],
				textSegments: [],
			};

			if (isSelfClosing) {
				if (stack.length > 0) {
					stack[stack.length - 1]?.children.push(node);
				} else if (!rootNode) {
					rootNode = node;
				} else {
					return null;
				}
			} else {
				stack.push(node);
			}
		}

		lastIndex = matchIndex + fullMatch.length;
	}

	if (stack.length > 0) {
		return null;
	}

	if (lastIndex < xml.length && xml.slice(lastIndex).trim().length > 0) {
		return null;
	}

	return rootNode;
}

function convertChildrenToObject(children: XmlNode[], schema: JsonSchema): Record<string, unknown> {
	const objectValue: Record<string, unknown> = {};

	for (const child of children) {
		const propertySchema = getPropertySchema(schema, child.name);
		const propertyValue = convertXmlNodeValue(child, propertySchema);
		const existingValue = objectValue[child.name];

		if (existingValue === undefined) {
			objectValue[child.name] = propertyValue;
			continue;
		}

		if (Array.isArray(existingValue)) {
			existingValue.push(propertyValue);
			continue;
		}

		objectValue[child.name] = [existingValue, propertyValue];
	}

	return objectValue;
}

function convertXmlNodeValue(node: XmlNode, schema: JsonSchema): unknown {
	const normalizedSchema = normalizeSchema(schema);

	if (node.children.length === 0) {
		return coerceXmlValue(node.textSegments.join(""), normalizedSchema);
	}

	if (shouldTreatAsArray(node, normalizedSchema)) {
		const itemSchema = getArrayItemSchema(normalizedSchema);
		const itemNodes = node.children.filter((child) => child.name === "item");
		return itemNodes.map((child) => convertXmlNodeValue(child, itemSchema));
	}

	return convertChildrenToObject(node.children, normalizedSchema);
}

function shouldTreatAsArray(node: XmlNode, schema: JsonSchema): boolean {
	const types = getSchemaTypes(schema);
	if (types.includes("array")) {
		return true;
	}

	return node.children.every((child) => child.name === "item");
}

function getArrayItemSchema(schema: JsonSchema): JsonSchema {
	if (!schema || typeof schema !== "object") {
		return undefined;
	}

	const items = schema.items;
	if (items && !Array.isArray(items) && typeof items === "object") {
		return items as Record<string, unknown>;
	}

	return undefined;
}

function getPropertySchema(schema: JsonSchema, propertyName: string): JsonSchema {
	if (!schema || typeof schema !== "object") {
		return undefined;
	}

	const properties = schema.properties;
	if (properties && typeof properties === "object" && !Array.isArray(properties)) {
		const propertySchema = (properties as Record<string, unknown>)[propertyName];
		if (propertySchema === undefined || typeof propertySchema === "boolean" || typeof propertySchema === "object") {
			return propertySchema as JsonSchema;
		}
	}

	for (const unionKey of ["anyOf", "oneOf", "allOf"]) {
		const unionSchemas = schema[unionKey];
		if (!Array.isArray(unionSchemas)) {
			continue;
		}

		for (const unionSchema of unionSchemas) {
			if (typeof unionSchema !== "object" || unionSchema === null) {
				continue;
			}

			const nestedPropertySchema = getPropertySchema(unionSchema as Record<string, unknown>, propertyName);
			if (nestedPropertySchema !== undefined) {
				return nestedPropertySchema;
			}
		}
	}

	return undefined;
}

function getSchemaTypes(schema: JsonSchema): string[] {
	if (!schema || typeof schema !== "object") {
		return [];
	}

	const schemaType = schema.type;
	if (typeof schemaType === "string") {
		return [schemaType];
	}

	if (Array.isArray(schemaType)) {
		return schemaType.filter((value): value is string => typeof value === "string");
	}

	return [];
}

function coerceXmlValue(rawValue: string, schema: JsonSchema): unknown {
	const decodedValue = unescapeXml(rawValue);
	const trimmedValue = decodedValue.trim();
	const types = getSchemaTypes(schema);

	if (types.includes("integer") && /^-?\d+$/.test(trimmedValue)) {
		return Number.parseInt(trimmedValue, 10);
	}

	if (types.includes("number") && /^-?(?:\d+|\d*\.\d+)$/.test(trimmedValue)) {
		return Number(trimmedValue);
	}

	if (types.includes("boolean")) {
		if (trimmedValue === "true") {
			return true;
		}

		if (trimmedValue === "false") {
			return false;
		}
	}

	if (types.includes("null") && trimmedValue === "null") {
		return null;
	}

	if ((types.includes("array") || types.includes("object")) && trimmedValue.length > 0) {
		try {
			return JSON.parse(trimmedValue);
		} catch {}
	}

	return decodedValue;
}

function coercePartialXmlValue(rawValue: string, schema: JsonSchema): unknown {
	const types = getSchemaTypes(schema);
	if (types.includes("integer") || types.includes("number")) {
		const trimmedValue = unescapeXml(rawValue).trim();
		if (trimmedValue.length > 0 && /^-?(?:\d+|\d*\.\d+)$/.test(trimmedValue)) {
			return types.includes("integer") ? Number.parseInt(trimmedValue, 10) : Number(trimmedValue);
		}
	}

	return unescapeXml(rawValue);
}

function parseOpeningTag(text: string, startIndex: number): { endIndex: number; name: string } | null {
	const tagPattern = /<\s*([A-Za-z_][\w.-]*)\s*>/y;
	tagPattern.lastIndex = startIndex;
	const match = tagPattern.exec(text);
	const tagName = match?.[1];
	if (!match || !tagName) {
		return null;
	}

	return {
		endIndex: match.index + match[0].length,
		name: tagName,
	};
}

function findEarliestToolOpeningTag(
	text: string,
	toolNames: string[],
): { index: number; name: string; tag: string } | null {
	let earliestTag: { index: number; name: string; tag: string } | null = null;

	for (const toolName of toolNames) {
		const tag = `<${toolName}>`;
		const tagIndex = text.indexOf(tag);
		if (tagIndex === -1) {
			continue;
		}

		if (!earliestTag || tagIndex < earliestTag.index) {
			earliestTag = { index: tagIndex, name: toolName, tag };
		}
	}

	return earliestTag;
}

function getSafeTextLength(text: string, toolNames: string[]): number {
	const lastTagIndex = text.lastIndexOf("<");
	if (lastTagIndex === -1) {
		return text.length;
	}

	const trailingCandidate = text.slice(lastTagIndex);
	const hasPotentialToolStart = toolNames.some((toolName) => `<${toolName}>`.startsWith(trailingCandidate));
	if (!hasPotentialToolStart) {
		return text.length;
	}

	return lastTagIndex;
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
