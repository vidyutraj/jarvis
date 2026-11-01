/**
 * Jarvis is single-user: only the Google account in ALLOWED_EMAIL may sign in.
 * Fails closed: if ALLOWED_EMAIL isn't configured, nobody is allowed.
 */
export function isAllowedEmail(
	email: string | undefined,
	allowedEmail: string | undefined,
): boolean {
	const allowed = normalize(allowedEmail);
	return allowed !== "" && normalize(email) === allowed;
}

function normalize(email: string | undefined): string {
	return (email ?? "").trim().toLowerCase();
}
