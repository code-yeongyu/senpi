/**
 * Why a provider must stay on the device whatever the sidecar asks for (custody gate H1, M1).
 *
 * The models.json schema accepts unknown keys at every level, so the walk here applies
 * `MODELS_JSON_FIELD_CLASSES` to the concrete provider object with whitelist semantics: a key the
 * table does not name, at any depth, keeps the provider on the device instead of reaching the brain.
 */

import type { ModelsJsonProvider } from "../model-config-schema.ts";
import {
	classifyModelsJsonField,
	type FieldClass,
	MODELS_JSON_FIELD_CLASSES,
	MODELS_JSON_TYPE_ONLY_FIELDS,
} from "./classify.ts";
import { splitEndpoint } from "./endpoint.ts";

export type DeviceCustodyReason =
	| "undeclared-field"
	| "extra-body"
	| "sampling-params"
	| "unsplittable-base-url"
	| "model-base-url-secret"
	| "model-header-collision";

const STOPS_WALK: ReadonlySet<FieldClass> = new Set(["sealed", "device-only"]);

/** Every path in the tables plus each of its ancestors (`a.b[].c` -> `a`, `a.b`, `a.b[]`, `a.b[].c`). */
const KNOWN_PATHS: ReadonlySet<string> = new Set(
	[...Object.keys(MODELS_JSON_FIELD_CLASSES), ...Object.keys(MODELS_JSON_TYPE_ONLY_FIELDS)].flatMap((path) => [
		...[...path.matchAll(/[.[]/g)].map((boundary) => path.slice(0, boundary.index)),
		path,
	]),
);

/** A property name that would read as path syntax (`a.b`, `m[]`, `*`, `{key}`) is never a declared field. */
const PATH_SYNTAX = /[.[\]*{}]/;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(value: unknown, path: string, reasons: Set<DeviceCustodyReason>): void {
	const fieldClass = classifyModelsJsonField(path);
	if (fieldClass === "forces-device") {
		const sampling = path.endsWith("samplingParams.*");
		if (!sampling) reasons.add("extra-body");
		else if (typeof value === "string" || (typeof value === "object" && value !== null))
			reasons.add("sampling-params");
		return;
	}
	if (fieldClass !== undefined && STOPS_WALK.has(fieldClass)) return;
	if (Array.isArray(value)) {
		for (const item of value) walk(item, `${path}[]`, reasons);
		return;
	}
	if (!isPlainObject(value)) {
		if (fieldClass === undefined) reasons.add("undeclared-field");
		return;
	}
	const isRecord = classifyModelsJsonField(`${path}.{key}`) !== undefined;
	for (const [key, child] of Object.entries(value)) {
		const childPath = isRecord ? `${path}.*` : `${path}.${key}`;
		if ((isRecord || !PATH_SYNTAX.test(key)) && KNOWN_PATHS.has(childPath)) walk(child, childPath, reasons);
		else reasons.add("undeclared-field");
	}
}

function hasModelHeaderCollision(provider: ModelsJsonProvider): boolean {
	return (provider.models ?? []).some((model) => {
		const override = Object.hasOwn(provider.modelOverrides ?? {}, model.id)
			? provider.modelOverrides?.[model.id]?.headers
			: undefined;
		if (override === undefined) return false;
		const overrideNames = new Set(Object.keys(override).map((name) => name.toLowerCase()));
		return Object.keys(model.headers ?? {}).some((name) => overrideNames.has(name.toLowerCase()));
	});
}

/** Empty when sealed custody may serve the provider. */
export function deviceCustodyReasons(provider: ModelsJsonProvider): readonly DeviceCustodyReason[] {
	const reasons = new Set<DeviceCustodyReason>();
	walk(provider, "providers.*", reasons);
	if (provider.baseUrl !== undefined && !splitEndpoint(provider.baseUrl).ok) reasons.add("unsplittable-base-url");
	for (const model of provider.models ?? []) {
		if (model.baseUrl === undefined) continue;
		const split = splitEndpoint(model.baseUrl);
		if (!split.ok) reasons.add("unsplittable-base-url");
		else if (split.secrets.size > 0) reasons.add("model-base-url-secret");
	}
	if (hasModelHeaderCollision(provider)) reasons.add("model-header-collision");
	return [...reasons];
}
