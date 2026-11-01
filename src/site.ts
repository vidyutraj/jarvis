import { documentPage } from "./auth/pages";

/**
 * Public pages required by Google's OAuth consent screen (home page + privacy
 * policy). Static text only; nothing here touches user data.
 */
const HOME_TITLE = "Jarvis";
const HOME_TEXT =
	"Jarvis is a private, single-user voice assistant. It connects Claude to its owner's own tools " +
	"(notes, calendar) and can only be used by the owner's Google account.";

const PRIVACY_TITLE = "Jarvis privacy policy";
const PRIVACY_INTRO = "Last updated November 1, 2026.";
const PRIVACY_SECTIONS: (readonly [heading: string, text: string])[] = [
	[
		"Who can use Jarvis",
		"Jarvis is a personal app with a single user: its owner. Sign-in is restricted to one Google account; anyone else is refused before any access is granted.",
	],
	[
		"What Google data Jarvis accesses",
		"Your Google account email (to confirm it's you), the list of calendars you're subscribed to (read-only), and your calendar events (to create and edit events you ask for). Jarvis does not access calendar settings or sharing, and does not delete calendars.",
	],
	[
		"Other data",
		"Notes you ask Jarvis to save are sent to the owner's own Telegram chat. Jarvis does not keep a copy.",
	],
	[
		"Storage and security",
		"Sign-in tokens are stored encrypted on Cloudflare and are never logged. Jarvis does not sell, share or transfer your data to anyone, and does not use it for advertising or to train AI models.",
	],
	[
		"Google API Services User Data Policy",
		"Jarvis's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.",
	],
	[
		"Revoking access",
		"Remove Jarvis at myaccount.google.com/permissions, or disconnect it in Claude's settings. Revoking access stops Jarvis from reaching your Google data immediately.",
	],
];

const HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "public, max-age=3600",
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
	"X-Frame-Options": "DENY",
};

export function sitePage(pathname: string): Response | null {
	if (pathname === "/") {
		return new Response(documentPage(HOME_TITLE, HOME_TEXT), { headers: HEADERS });
	}
	if (pathname === "/privacy") {
		return new Response(documentPage(PRIVACY_TITLE, PRIVACY_INTRO, PRIVACY_SECTIONS), {
			headers: HEADERS,
		});
	}
	return null;
}
