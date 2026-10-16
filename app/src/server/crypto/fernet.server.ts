/**
 * Fernet (https://github.com/fernet/spec) on node:crypto, byte-compatible with
 * Python's `cryptography.fernet.Fernet`, which the FastAPI backend used to
 * encrypt Connected Account app passwords (backend/tasks_api/crypto.py).
 *
 * Token layout, base64url with padding:
 *   0x80 | timestamp (u64 BE, seconds) | IV (16) | AES-128-CBC ciphertext (PKCS7) | HMAC-SHA256 (32)
 * The 32-byte key is base64url: the first 16 bytes sign, the last 16 encrypt.
 *
 * Storage: Python stored the token's base64url ASCII bytes in the bytea column,
 * so `encryptAppPassword` returns those bytes and `decryptAppPassword` takes them.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

const VERSION = 0x80;
const HEADER_LEN = 1 + 8 + 16;
const HMAC_LEN = 32;
const BLOCK = 16;
/** cryptography's _MAX_CLOCK_SKEW. */
const MAX_CLOCK_SKEW_SECONDS = 60;
const BASE64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

export class InvalidToken extends Error {
	constructor() {
		super("invalid Fernet token");
		this.name = "InvalidToken";
	}
}

/** Strict base64url (with or without padding), like Python's urlsafe_b64decode on valid input. */
function decodeBase64Url(text: string): Buffer | null {
	if (!BASE64URL_RE.test(text) || text.length % 4 === 1) return null;
	return Buffer.from(text, "base64url");
}

function encodeBase64Url(bytes: Buffer): string {
	// Python's urlsafe_b64encode keeps the `=` padding; Node's base64url drops it.
	return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

interface FernetKey {
	signing: Buffer;
	encryption: Buffer;
}

function parseKey(key: string): FernetKey {
	const raw = decodeBase64Url(key);
	if (raw === null || raw.length !== 32) {
		throw new Error("Fernet key must be 32 url-safe base64-encoded bytes.");
	}
	return { signing: raw.subarray(0, 16), encryption: raw.subarray(16) };
}

function sign(key: FernetKey, data: Buffer): Buffer {
	return createHmac("sha256", key.signing).update(data).digest();
}

export interface EncryptOptions {
	/** Seconds since the epoch. Defaults to now. */
	now?: number;
	/** 16-byte IV. Defaults to random. Pass one only in tests. */
	iv?: Uint8Array;
}

/** Python `Fernet(key).encrypt(data)`, returning the token text. */
export function fernetEncrypt(
	key: string,
	data: Uint8Array | string,
	options: EncryptOptions = {},
): string {
	const k = parseKey(key);
	const plaintext =
		typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	const iv = options.iv ? Buffer.from(options.iv) : randomBytes(BLOCK);
	if (iv.length !== BLOCK) throw new Error("Fernet IV must be 16 bytes.");
	const now = options.now ?? Math.floor(Date.now() / 1000);

	const cipher = createCipheriv("aes-128-cbc", k.encryption, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

	const header = Buffer.alloc(9);
	header[0] = VERSION;
	header.writeBigUInt64BE(BigInt(now), 1);
	const body = Buffer.concat([header, iv, ciphertext]);
	return encodeBase64Url(Buffer.concat([body, sign(k, body)]));
}

export interface DecryptOptions {
	/** Reject tokens older than this many seconds (and far-future ones). */
	ttlSeconds?: number;
	/** Seconds since the epoch. Defaults to now. Used only with ttlSeconds. */
	now?: number;
}

/** Python `Fernet(key).decrypt(token, ttl)`. Throws InvalidToken on any failure. */
export function fernetDecrypt(
	key: string,
	token: string | Uint8Array,
	options: DecryptOptions = {},
): Uint8Array {
	const k = parseKey(key);
	const text =
		typeof token === "string" ? token : Buffer.from(token).toString("latin1");
	const data = decodeBase64Url(text);
	if (data === null || data.length < 9 || data[0] !== VERSION) {
		throw new InvalidToken();
	}
	const timestamp = Number(data.readBigUInt64BE(1));
	if (options.ttlSeconds !== undefined) {
		const now = options.now ?? Math.floor(Date.now() / 1000);
		if (timestamp + options.ttlSeconds < now) throw new InvalidToken();
		if (now + MAX_CLOCK_SKEW_SECONDS < timestamp) throw new InvalidToken();
	}
	if (data.length < HEADER_LEN + HMAC_LEN) throw new InvalidToken();
	const body = data.subarray(0, data.length - HMAC_LEN);
	const mac = data.subarray(data.length - HMAC_LEN);
	if (!timingSafeEqual(sign(k, body), mac)) throw new InvalidToken();

	const iv = data.subarray(9, HEADER_LEN);
	const ciphertext = data.subarray(HEADER_LEN, data.length - HMAC_LEN);
	try {
		const decipher = createDecipheriv("aes-128-cbc", k.encryption, iv);
		return new Uint8Array(
			Buffer.concat([decipher.update(ciphertext), decipher.final()]),
		);
	} catch {
		throw new InvalidToken();
	}
}

/** crypto.py `encrypt_app_password`: the token's ASCII bytes, as stored in bytea. */
export function encryptAppPassword(
	plaintext: string,
	fernetKey: string,
): Uint8Array {
	return new Uint8Array(
		Buffer.from(fernetEncrypt(fernetKey, plaintext), "ascii"),
	);
}

/** crypto.py `decrypt_app_password`. */
export function decryptAppPassword(
	ciphertext: Uint8Array,
	fernetKey: string,
): string {
	return Buffer.from(fernetDecrypt(fernetKey, ciphertext)).toString("utf8");
}
