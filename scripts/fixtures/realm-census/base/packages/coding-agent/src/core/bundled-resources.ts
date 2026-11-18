// Source 3: engine-owned extension packages, resolved by name at run time.
export const bundledBuiltinExtensions = [
	{ id: "codemode", resolvePackage: () => "@code-yeongyu/senpi-codemode/package.json" },
] as const;
