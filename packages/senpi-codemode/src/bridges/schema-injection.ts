export function injectSchemaInstruction(prompt: string, schema: unknown): string {
	return `${prompt}\n\nRespond ONLY with JSON matching this JSON-Schema:\n${JSON.stringify(schema)}`;
}
