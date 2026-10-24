import { stripVTControlCharacters } from "node:util";
import type { McpMrtrPresentation } from "../../../../mcp-mrtr-presentations.ts";
import { McpMrtrError } from "./errors.ts";

type Value = string | number | boolean | string[];
export type MrtrInputResponse = { action: "accept"; content: Record<string, Value> } | { action: "decline" | "cancel" };
type Property = Record<string, unknown>;
type Form = { type: "object"; properties: Record<string, Property>; required?: string[] };
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const inert = (value: string) =>
	stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

function enums(property: Property): Array<{ value: string; label: string }> | undefined {
	if (
		Array.isArray(property.enum) &&
		property.enum.length > 0 &&
		property.enum.every((entry) => typeof entry === "string")
	) {
		return property.enum.map((value) => ({ value, label: value }));
	}
	const choices = property.oneOf ?? property.anyOf;
	if (
		Array.isArray(choices) &&
		choices.length > 0 &&
		choices.every(
			(entry) =>
				isRecord(entry) &&
				typeof entry.const === "string" &&
				typeof entry.title === "string" &&
				Object.keys(entry).every((key) => key === "const" || key === "title"),
		)
	) {
		return choices.map((entry) => ({ value: entry.const as string, label: entry.title as string }));
	}
	return undefined;
}

function validValue(property: Property, value: unknown): value is Value {
	if (property.type === "boolean") return typeof value === "boolean";
	if (property.type === "integer" || property.type === "number") {
		return (
			typeof value === "number" &&
			Number.isFinite(value) &&
			(property.type !== "integer" || Number.isInteger(value)) &&
			(typeof property.minimum !== "number" || value >= property.minimum) &&
			(typeof property.maximum !== "number" || value <= property.maximum)
		);
	}
	if (property.type === "array") {
		const choices = isRecord(property.items) ? enums(property.items) : undefined;
		return (
			Array.isArray(value) &&
			value.every((entry) => typeof entry === "string" && choices?.some((choice) => choice.value === entry)) &&
			new Set(value).size === value.length &&
			(typeof property.minItems !== "number" || value.length >= property.minItems) &&
			(typeof property.maxItems !== "number" || value.length <= property.maxItems)
		);
	}
	if (typeof value !== "string") return false;
	const choices = enums(property);
	if (choices && !choices.some((choice) => choice.value === value)) return false;
	if (typeof property.minLength === "number" && [...value].length < property.minLength) return false;
	if (typeof property.maxLength === "number" && [...value].length > property.maxLength) return false;
	switch (property.format) {
		case "email":
			return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
		case "uri": {
			try {
				return new URL(value).protocol.length > 1;
			} catch {
				return false;
			}
		}
		case "date":
			return (
				/^\d{4}-\d{2}-\d{2}$/.test(value) &&
				Number.isFinite(Date.parse(value)) &&
				new Date(value).toISOString().slice(0, 10) === value
			);
		case "date-time": {
			const date = value.slice(0, 10);
			return (
				/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
					value,
				) &&
				Number.isFinite(Date.parse(value)) &&
				new Date(date).toISOString().slice(0, 10) === date
			);
		}
		default:
			return true;
	}
}

/** Reject unsupported constraints rather than presenting a weaker schema. */
export function validateMrtrForm(schema: unknown): schema is Form {
	if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return false;
	for (const key of ["title", "description"]) if (own(schema, key) && typeof schema[key] !== "string") return false;
	if (
		Object.keys(schema).some(
			(key) => !["type", "properties", "required", "title", "description", "$schema"].includes(key),
		)
	)
		return false;
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) ||
			!schema.required.every((key) => typeof key === "string" && own(schema.properties as object, key)))
	)
		return false;
	for (const property of Object.values(schema.properties)) {
		if (!isRecord(property)) return false;
		const allowed = ["type", "title", "description", "default"];
		switch (property.type) {
			case "string":
				allowed.push("minLength", "maxLength", "format", "enum", "oneOf");
				if (
					property.format !== undefined &&
					!["email", "uri", "date", "date-time"].includes(String(property.format))
				)
					return false;
				if ((own(property, "enum") || own(property, "oneOf")) && !enums(property)) return false;
				if (own(property, "enum") && own(property, "oneOf")) return false;
				break;
			case "number":
			case "integer":
				allowed.push("minimum", "maximum");
				break;
			case "boolean":
				break;
			case "array":
				allowed.push("items", "minItems", "maxItems");
				if (
					!isRecord(property.items) ||
					!enums(property.items) ||
					Object.keys(property.items).some((key) => !["type", "enum", "anyOf"].includes(key)) ||
					(property.items.type !== undefined && property.items.type !== "string")
				)
					return false;
				break;
			default:
				return false;
		}
		if (Object.keys(property).some((key) => !allowed.includes(key))) return false;
		for (const key of ["title", "description"])
			if (own(property, key) && typeof property[key] !== "string") return false;
		for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
			const value = property[key];
			if (
				value !== undefined &&
				(typeof value !== "number" ||
					!Number.isFinite(value) ||
					(!["minimum", "maximum"].includes(key) && (!Number.isInteger(value) || value < 0)))
			)
				return false;
		}
		for (const [min, max] of [
			["minimum", "maximum"],
			["minLength", "maxLength"],
			["minItems", "maxItems"],
		]) {
			if (
				min &&
				max &&
				typeof property[min] === "number" &&
				typeof property[max] === "number" &&
				property[min] > property[max]
			)
				return false;
		}
		if (own(property, "default") && !validValue(property, property.default)) return false;
	}
	return true;
}

/** No model-facing questions, RPC requests, timers, persistence, or network operations. */
export async function collectMrtrForm(
	presentation: McpMrtrPresentation,
	serverLabel: string,
	params: { message: string; requestedSchema: unknown },
	signal: AbortSignal,
): Promise<MrtrInputResponse> {
	if (!validateMrtrForm(params.requestedSchema)) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
	const schema = params.requestedSchema;
	const abort = new AbortController();
	const combined = AbortSignal.any([signal, presentation.signal, abort.signal]);
	const opts = { signal: combined, ephemeral: true };
	const heading = `MCP server: ${inert(serverLabel)}\n${inert(params.message)}`;
	const select = async (title: string, choices: string[]) => {
		if (combined.aborted) return undefined;
		const result = await presentation.ui.select(title, choices, opts);
		return combined.aborted ? undefined : result;
	};
	const content: Record<string, Value> = Object.create(null);
	const required = new Set(schema.required ?? []);
	const entries = Object.entries(schema.properties);
	const field = async (name: string, property: Property): Promise<boolean> => {
		const title = `${heading}\n${inert(String(property.title ?? name))}${typeof property.description === "string" ? `\n${inert(property.description)}` : ""}`;
		for (;;) {
			const actions = ["Enter value"];
			if (!required.has(name)) actions.push("Leave unset");
			if (own(property, "default")) actions.push("Use default");
			// Primitive selectors already require an explicit choice; do not conflate false with dismissal.
			let action = "Enter value";
			if (actions.length > 1) {
				const chosen = await select(title, actions);
				if (chosen === undefined) return false;
				action = chosen;
			}
			if (action === "Leave unset") {
				delete content[name];
				return true;
			}
			if (action === "Use default") {
				content[name] = structuredClone(property.default) as Value;
				return true;
			}
			let value: unknown;
			if (property.type === "boolean") {
				const chosen = await select(title, ["true", "false"]);
				if (chosen === undefined) return false;
				value = chosen === "true";
			} else if (property.type === "array" || enums(property)) {
				const choices =
					property.type === "array" && isRecord(property.items) ? enums(property.items) : enums(property);
				if (choices === undefined) return false;
				const values: string[] = [];
				for (;;) {
					const labels: string[] = choices.map(
						(choice, index) =>
							`${index + 1}. ${inert(choice.label)}${values.includes(choice.value) ? " [selected]" : ""}`,
					);
					if (property.type === "array") labels.push("Done");
					const chosen = await select(title, labels);
					if (chosen === undefined) return false;
					if (chosen === "Done") {
						value = values;
						break;
					}
					const index = labels.indexOf(chosen);
					const choice = choices[index];
					if (!choice) continue;
					if (property.type !== "array") {
						value = choice.value;
						break;
					}
					const existing = values.indexOf(choice.value);
					if (existing >= 0) values.splice(existing, 1);
					else values.push(choice.value);
				}
			} else {
				if (combined.aborted) return false;
				const text = await presentation.ui.input(title, undefined, opts);
				if (text === undefined || combined.aborted) return false;
				value =
					property.type === "number" || property.type === "integer"
						? text.trim() === ""
							? NaN
							: Number(text)
						: text;
			}
			if (validValue(property, value)) {
				content[name] = value;
				return true;
			}
			if ((await select(`${title}\nValue does not satisfy this field.`, ["Try again", "Cancel"])) !== "Try again")
				return false;
		}
	};
	try {
		const begin = await select(heading, ["Continue", "Decline", "Cancel"]);
		if (begin !== "Continue") return { action: begin === "Decline" ? "decline" : "cancel" };
		for (const [name, property] of entries) if (!(await field(name, property))) return { action: "cancel" };
		for (;;) {
			const review = entries
				.map(([name]) => `${inert(name)}: ${own(content, name) ? inert(JSON.stringify(content[name])) : "(unset)"}`)
				.join("\n");
			const action = await select(`${heading}\nReview\n${review}`, ["Submit", "Edit field", "Decline", "Cancel"]);
			if (action === "Submit" && !combined.aborted) return { action: "accept", content: structuredClone(content) };
			if (action !== "Edit field") return { action: action === "Decline" ? "decline" : "cancel" };
			const labels = entries.map(([name], index) => `${index + 1}. ${inert(name)}`);
			const chosen = await select(`${heading}\nEdit field`, labels);
			const entry = chosen === undefined ? undefined : entries[labels.indexOf(chosen)];
			if (!entry || !(await field(...entry))) return { action: "cancel" };
		}
	} finally {
		abort.abort();
		for (const key of Object.keys(content)) delete content[key];
	}
}
