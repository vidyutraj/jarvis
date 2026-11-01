import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

/** Escapes untrusted text (client names come from dynamic registration) for HTML. */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
	:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
	body { max-width: 28rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
	h1 { font-size: 1.4rem; }
	.note { padding: .75rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 8%, transparent); }
	button { font: inherit; padding: .6rem 1.2rem; border-radius: .5rem; border: 1px solid currentColor; cursor: pointer; }
	button[value="approve"] { background: #1a73e8; color: white; border-color: #1a73e8; }
`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<body>${body}</body>
</html>`;
}

/**
 * The consent page shown before sending the user to Google. Shows who is asking
 * and where access will be sent, so a look-alike app can't borrow this login.
 */
export function consentPage(details: ConsentDescription, handle: string): string {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name isn't verified.";
	const loopbackWarning = details.redirectIsLoopback
		? `<p class="note"><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it (for example, MCP Inspector).</p>`
		: "";

	return page(
		`Connect ${details.clientName} to Jarvis`,
		`<h1>Allow ${name} to use Jarvis?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<p>Next, you'll sign in with Google and allow Jarvis to read your calendar list and manage events.</p>
<form method="post">
	<input type="hidden" name="handle" value="${escapeHtml(handle)}">
	<p><button name="decision" value="approve">Continue to Google</button> <button name="decision" value="deny">Deny</button></p>
</form>`,
	);
}

/** A plain message page for errors that can't safely redirect back to the client. */
export function messagePage(title: string, message: string): string {
	return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/** A simple static document: a title, an optional intro, then headed sections. */
export function documentPage(
	title: string,
	intro: string,
	sections: readonly (readonly [heading: string, text: string])[] = [],
): string {
	const body = sections
		.map(([heading, text]) => `<h2>${escapeHtml(heading)}</h2><p>${escapeHtml(text)}</p>`)
		.join("\n");
	return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p>${body}`);
}
