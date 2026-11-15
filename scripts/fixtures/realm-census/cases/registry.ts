import { realmRegistry } from "@earendil-works/pi-realm-registry";

export const shared = realmRegistry(
	"@fixture/registry/v1",
	() => ({ get: () => 1 }),
	(value): value is { get: () => number } => typeof value === "object",
);
