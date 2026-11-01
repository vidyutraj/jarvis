/**
 * What a successful sign-in stores with the OAuth grant. The OAuth library
 * encrypts props at rest; only a valid access token can decrypt them.
 */
export interface AuthProps {
	/** Google's stable account ID. */
	sub: string;
	email: string;
	googleAccessToken: string;
	googleRefreshToken: string;
	/** Epoch milliseconds when googleAccessToken expires. */
	googleExpiresAt: number;
}

/** Narrows the untyped `ctx.props` from the OAuth library. */
export function isAuthProps(value: unknown): value is AuthProps {
	if (typeof value !== "object" || value === null) return false;
	const props = value as Record<string, unknown>;
	return (
		typeof props.sub === "string" &&
		typeof props.email === "string" &&
		typeof props.googleAccessToken === "string" &&
		typeof props.googleRefreshToken === "string" &&
		typeof props.googleExpiresAt === "number"
	);
}
