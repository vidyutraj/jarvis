/**
 * Encryption and signing for Jarvis's own data, keyed from one Worker secret
 * (JARVIS_SECRET_KEY: at least 32 random bytes, base64). Separate keys are
 * derived per purpose with HKDF, so a signed page link can never be used to
 * decrypt a stored bank token or vice versa.
 */

type KeyPurpose = "plaid-access-token" | "plaid-link-token" | "spending-link";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IV_BYTES = 12;
const MIN_SECRET_BYTES = 32;

export class MissingSecretKeyError extends Error {
	constructor() {
		super("JARVIS_SECRET_KEY is missing or shorter than 32 bytes.");
	}
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function masterKey(secret: string | undefined): Promise<CryptoKey> {
	let raw: Uint8Array;
	try {
		raw = fromBase64(secret?.trim() ?? "");
	} catch {
		throw new MissingSecretKeyError();
	}
	if (raw.length < MIN_SECRET_BYTES) throw new MissingSecretKeyError();
	return crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
}

async function deriveKey(
	secret: string | undefined,
	purpose: KeyPurpose,
	algorithm: { name: "AES-GCM"; length: 256 } | { name: "HMAC"; hash: "SHA-256" },
	usages: ("encrypt" | "decrypt" | "sign" | "verify")[],
): Promise<CryptoKey> {
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(purpose) },
		await masterKey(secret),
		algorithm,
		false,
		usages,
	);
}

/** AES-GCM encrypts `plaintext`; the result is base64(iv || ciphertext). Throws only on a missing key. */
export async function encryptSecret(
	secret: string | undefined,
	purpose: KeyPurpose,
	plaintext: string,
): Promise<string> {
	const key = await deriveKey(secret, purpose, { name: "AES-GCM", length: 256 }, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
	);
	const out = new Uint8Array(IV_BYTES + sealed.length);
	out.set(iv);
	out.set(sealed, IV_BYTES);
	return toBase64(out);
}

/** Reverses `encryptSecret`. Returns null if the value was tampered with or the key changed. */
export async function decryptSecret(
	secret: string | undefined,
	purpose: KeyPurpose,
	sealed: string,
): Promise<string | null> {
	const key = await deriveKey(secret, purpose, { name: "AES-GCM", length: 256 }, ["decrypt"]);
	try {
		const bytes = fromBase64(sealed);
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
			key,
			bytes.slice(IV_BYTES),
		);
		return decoder.decode(plain);
	} catch {
		return null;
	}
}

/** Hex SHA-256, for looking up a stored token without storing it in the clear. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const bytes = typeof value === "string" ? encoder.encode(value) : value;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hmacKey(secret: string | undefined, usage: "sign" | "verify"): Promise<CryptoKey> {
	return deriveKey(secret, "spending-link", { name: "HMAC", hash: "SHA-256" }, [usage]);
}

/** A short-lived bearer token for the spending page: `<expiresAtSeconds>.<signature>`. */
export async function signPageToken(
	secret: string | undefined,
	expiresAtSeconds: number,
): Promise<string> {
	const payload = String(expiresAtSeconds);
	const signature = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(secret, "sign"),
		encoder.encode(payload),
	);
	return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Checks the signature (constant-time, via WebCrypto) and expiry of a page token. */
export async function verifyPageToken(
	secret: string | undefined,
	token: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	const match = /^(\d{1,12})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
	if (!match) return false;
	const [, payload, signature] = match as unknown as [string, string, string];
	if (Number(payload) < nowSeconds) return false;
	let signatureBytes: Uint8Array;
	try {
		signatureBytes = fromBase64(
			signature.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(signature.length / 4) * 4, "="),
		);
	} catch {
		return false;
	}
	try {
		return await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret, "verify"),
			signatureBytes,
			encoder.encode(payload),
		);
	} catch (error) {
		if (error instanceof MissingSecretKeyError) return false;
		throw error;
	}
}
