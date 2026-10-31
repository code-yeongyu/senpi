import { stripVTControlCharacters } from "node:util";
import type { McpMrtrPresentation } from "../../../../mcp-mrtr-presentations.ts";
import { bindMcpFormPresented } from "../../../../mcp-form-types.ts";
import { McpMrtrError } from "./errors.ts";
import { enums, isRecord, type Property, validValue, validateMrtrForm, type Value } from "./form-schema.ts";

export type MrtrInputResponse = { action: "accept"; content: Record<string, Value> } | { action: "decline" | "cancel" };
const own = (value: object, key: string) => Object.hasOwn(value, key);
const inert = (value: string) =>
	stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

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
	bindMcpFormPresented(opts, presentation.presented);
	const heading = `MCP server: ${inert(serverLabel)}\n${inert(params.message)}`;
	const select = async (title: string, choices: string[]) => {
		if (combined.aborted) return undefined;
		const answer = presentation.ui.select(title, choices, opts);
		const result = await answer;
		return combined.aborted ? undefined : result;
	};
	const content: Record<string, Value> = Object.create(null);
	const finish = (result: MrtrInputResponse): MrtrInputResponse => {
		if (!combined.aborted) presentation.admit?.();
		return result;
	};
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
		if (begin !== "Continue") return finish({ action: begin === "Decline" ? "decline" : "cancel" });
		for (const [name, property] of entries) if (!(await field(name, property))) return finish({ action: "cancel" });
		for (;;) {
			const review = entries
				.map(([name]) => `${inert(name)}: ${own(content, name) ? inert(JSON.stringify(content[name])) : "(unset)"}`)
				.join("\n");
			const action = await select(`${heading}\nReview\n${review}`, ["Submit", "Edit field", "Decline", "Cancel"]);
			if (action === "Submit" && !combined.aborted)
				return finish({ action: "accept", content: structuredClone(content) });
			if (action !== "Edit field") return finish({ action: action === "Decline" ? "decline" : "cancel" });
			const labels = entries.map(([name], index) => `${index + 1}. ${inert(name)}`);
			const chosen = await select(`${heading}\nEdit field`, labels);
			const entry = chosen === undefined ? undefined : entries[labels.indexOf(chosen)];
			if (!entry || !(await field(...entry))) return finish({ action: "cancel" });
		}
	} finally {
		bindMcpFormPresented(opts, undefined);
		abort.abort();
		for (const key of Object.keys(content)) delete content[key];
	}
}
