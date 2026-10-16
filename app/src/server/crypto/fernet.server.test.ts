import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
	decryptAppPassword,
	encryptAppPassword,
	fernetDecrypt,
	fernetEncrypt,
	InvalidToken,
} from "./fernet.server";
import python from "./fixtures/fernet-python.json";
import spec from "./fixtures/fernet-spec.json";

const epochSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

describe("Fernet spec vectors", () => {
	test.each(spec.generate)("generate: $src", (v) => {
		const token = fernetEncrypt(v.secret, v.src, {
			now: epochSeconds(v.now),
			iv: Uint8Array.from(v.iv),
		});
		expect(token).toBe(v.token);
	});

	test.each(spec.verify)("verify: $src", (v) => {
		const out = fernetDecrypt(v.secret, v.token, {
			ttlSeconds: v.ttl_sec,
			now: epochSeconds(v.now),
		});
		expect(utf8(out)).toBe(v.src);
	});

	test.each(spec.invalid)("invalid: $desc", (v) => {
		expect(() =>
			fernetDecrypt(v.secret, v.token, {
				ttlSeconds: v.ttl_sec,
				now: epochSeconds(v.now),
			}),
		).toThrow(InvalidToken);
	});
});

describe("compatibility with Python cryptography", () => {
	test("decrypts a token Python produced", () => {
		expect(utf8(fernetDecrypt(python.key, python.random_token))).toBe(
			python.plaintext,
		);
	});

	test("produces the same bytes as Python for the same time and IV", () => {
		const token = fernetEncrypt(python.key, python.plaintext, {
			now: python.fixed_parts.now,
			iv: Buffer.from(python.fixed_parts.iv_hex, "hex"),
		});
		expect(token).toBe(python.fixed_parts.token);
	});

	test("reads the bytea value Python stored (token ASCII bytes)", () => {
		const stored = new Uint8Array(Buffer.from(python.random_token, "ascii"));
		expect(decryptAppPassword(stored, python.key)).toBe(python.plaintext);
	});

	test("stores the token as base64url ASCII with padding, like Python", () => {
		const stored = encryptAppPassword("secret", python.key);
		const text = Buffer.from(stored).toString("ascii");
		expect(text).toMatch(/^gAAAAA[A-Za-z0-9_-]+={0,2}$/);
		expect(text.length % 4).toBe(0);
	});

	// Runs only when TASKS_FERNET_PYTHON points at a Python with `cryptography`,
	// e.g. TASKS_FERNET_PYTHON=../backend/.venv/bin/python bun run test
	const pythonBin = process.env.TASKS_FERNET_PYTHON;
	test.skipIf(!pythonBin)("Python decrypts a token this module made", () => {
		const token = fernetEncrypt(python.key, python.plaintext);
		const script =
			"import sys; from cryptography.fernet import Fernet; " +
			"sys.stdout.write(Fernet(sys.argv[1].encode()).decrypt(sys.argv[2].encode()).decode())";
		const proc = Bun.spawnSync([
			pythonBin ?? "",
			"-I",
			"-c",
			script,
			python.key,
			token,
		]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe(python.plaintext);
	});
});

describe("round trip", () => {
	const key = python.key;

	test("any UTF-8 string survives encrypt then decrypt", () => {
		fc.assert(
			fc.property(fc.string({ unit: "grapheme" }), (plaintext) => {
				const stored = encryptAppPassword(plaintext, key);
				expect(decryptAppPassword(stored, key)).toBe(plaintext);
			}),
		);
	});

	test("a flipped byte anywhere is rejected", () => {
		const token = Buffer.from(fernetEncrypt(key, "hello"), "base64url");
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: token.length - 1 }),
				fc.integer({ min: 1, max: 255 }),
				(index, mask) => {
					const copy = Buffer.from(token);
					copy[index] = (copy[index] ?? 0) ^ mask;
					const tampered = copy
						.toString("base64")
						.replaceAll("+", "-")
						.replaceAll("/", "_");
					expect(() => fernetDecrypt(key, tampered)).toThrow(InvalidToken);
				},
			),
		);
	});

	test("rejects a key that is not 32 bytes", () => {
		expect(() => fernetEncrypt("c2hvcnQ=", "x")).toThrow(/32 url-safe/);
	});
});
