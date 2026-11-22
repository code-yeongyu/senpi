/**
 * Vendored contract: the ownership marker `omo-desktop-home.json` the OmO desktop writes in every data home it
 * owns (omo-desktop-app `packages/contracts/src/desktopDataHome.ts`, plan section 2). A breadcrumb is trusted only
 * when the home it points at carries this marker with the same `homeId` (senpi#2898).
 */
export const DESKTOP_HOME_MARKER_FILE = "omo-desktop-home.json";

export type DesktopHomeMarker =
	| { readonly kind: "valid"; readonly homeId: string }
	| { readonly kind: "newer"; readonly schemaVersion: number }
	| { readonly kind: "invalid" };

export function parseDesktopHomeMarker(raw: unknown): DesktopHomeMarker {
	if (typeof raw !== "object" || raw === null) return { kind: "invalid" };
	const record = raw as Record<string, unknown>;
	if (record.kind !== "omo-desktop-data-home" || record.appId !== "com.omo.desktop") return { kind: "invalid" };
	if (typeof record.schemaVersion === "number" && record.schemaVersion > 1)
		return { kind: "newer", schemaVersion: record.schemaVersion };
	if (record.schemaVersion !== 1 || typeof record.homeId !== "string" || record.homeId.length === 0)
		return { kind: "invalid" };
	return { kind: "valid", homeId: record.homeId };
}
