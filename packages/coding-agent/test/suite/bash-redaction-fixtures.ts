/** Deliberately synthetic credentials assembled at runtime, never stored as token-shaped literals. */
export function secretOutputCases(): Array<{ name: string; input: string; expected: string }> {
	const prefixes = [
		["gh", "p_"],
		["gh", "o_"],
		["gh", "s_"],
		["github", "_pat_"],
		...["a", "b", "p", "o", "r", "s"].map((kind) => ["xo", "x", kind, "-"]),
		["s", "k-"],
		["s", "k-ant-"],
		["s", "k-proj-"],
	];
	return [
		...prefixes.map((parts, index) => ({
			name: `prefix ${index}`,
			input: parts.join("") + "synthetic123".repeat(4),
			expected: "<redacted>",
		})),
		{ name: "AWS", input: ["AK", "IA", "A1".repeat(8)].join(""), expected: "<redacted>" },
		{ name: "Google", input: ["AI", "za", "a".repeat(35)].join(""), expected: "<redacted>" },
		{
			name: "JWT",
			input: [
				Buffer.from('{"alg":"HS256"}').toString("base64url"),
				Buffer.from('{"sub":"test"}').toString("base64url"),
				"signature123",
			].join("."),
			expected: "<redacted>",
		},
		{
			name: "PEM",
			input: [
				"-----BEGIN ",
				"RSA PRIVATE KEY-----\n",
				Buffer.from("synthetic key material").toString("base64"),
				"\n-----END ",
				"RSA PRIVATE KEY-----",
			].join(""),
			expected: "<redacted>",
		},
		{ name: "Bearer", input: ["Bearer ", "synthetic-value123"].join(""), expected: "Bearer <redacted>" },
		...["API_KEY", "ACCESS_TOKEN", "CLIENT_SECRET", "PASSWORD", "DB_PASSWORD_FILE", "HTTP_AUTHORIZATION"].map(
			(key) => ({
				name: key,
				input: `${key}=synthetic-value123`,
				expected: `${key}=<redacted>`,
			}),
		),
		{
			name: "quoted assignment",
			input: 'DB_PASSWORD="synthetic multi word value"',
			expected: 'DB_PASSWORD="<redacted>"',
		},
	];
}
