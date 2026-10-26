import type { ConfigValue } from "@earendil-works/pi-ai/utils/config-reference";
import { rememberConfigReferenceOrigin } from "./config-reference-resolver.ts";
import type { ModelsJsonProvider } from "./model-config-schema.ts";

/** Register only schema-listed value slots on the retained, immutable snapshot. */
export function rememberModelReferenceOrigins(provider: ModelsJsonProvider, origin: string, providerId: string): void {
	const remember = (value: ConfigValue | undefined, field: string) => {
		if (value !== undefined) rememberConfigReferenceOrigin(value, { origin, authority: "trusted", field });
	};
	const headers = (values: Record<string, ConfigValue> | undefined, field: string) => {
		for (const [name, value] of Object.entries(values ?? {})) remember(value, `${field}.${name}`);
	};
	const field = `providers.${providerId}`;
	remember(provider.apiKey, `${field}.apiKey`);
	headers(provider.headers, `${field}.headers`);
	for (const [index, model] of (provider.models ?? []).entries()) {
		headers(model.headers, `${field}.models.${index}.headers`);
	}
	for (const [name, model] of Object.entries(provider.modelOverrides ?? {})) {
		headers(model.headers, `${field}.modelOverrides.${name}.headers`);
	}
	for (const [name, slot] of Object.entries(provider.credentials?.slots ?? {})) {
		remember(slot.value, `${field}.credentials.slots.${name}.value`);
	}
}
