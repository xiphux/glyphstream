/**
 * A software WebAuthn authenticator: a real P-256 key, real authenticatorData,
 * real ECDSA signatures, and a "none" attestation — enough for the unmodified
 * @simplewebauthn/server to verify its output end to end in a node test.
 *
 * Each ceremony takes overrides for the one field a negative test wants wrong
 * (origin, rpId, flags, counter, signing key), so every refusal is produced by
 * the library's own checks rather than by a mocked `verified: false`.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

/** CBOR major-type header for a byte/text string or map of `len`. */
function cborHead(major: number, len: number): Buffer {
	if (len < 24) return Buffer.from([(major << 5) | len]);
	if (len < 256) return Buffer.from([(major << 5) | 24, len]);
	return Buffer.from([(major << 5) | 25, len >> 8, len & 0xff]);
}
const cborText = (s: string) => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = (b: Uint8Array) => Buffer.concat([cborHead(2, b.length), b]);

function keyPair() {
	return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

export interface CeremonyOverrides {
	origin?: string;
	rpId?: string;
	/** Authenticator flags; defaults to UP|UV (plus AT on registration). */
	flags?: number;
	/** Signature counter to report. */
	counter?: number;
	/** Sign with this key instead of the credential's. */
	signingKey?: KeyObject;
	/** base64url userHandle override; `null` omits it. */
	userHandle?: string | null;
}

export class SoftAuthenticator {
	readonly credentialId = randomBytes(16);
	private readonly keys = keyPair();

	constructor(
		private readonly rpId: string,
		private readonly origin: string,
	) {}

	get id(): string {
		return b64u(this.credentialId);
	}

	/** The credential public key as a COSE_Key (EC2, ES256), as it is stored. */
	cosePublicKey(): Buffer {
		const jwk = this.keys.publicKey.export({ format: 'jwk' });
		const x = Buffer.from(jwk.x!, 'base64url');
		const y = Buffer.from(jwk.y!, 'base64url');
		// {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
		return Buffer.concat([
			Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
			cborBytes(x),
			Buffer.from([0x22]),
			cborBytes(y),
		]);
	}

	/** A different key, for "signed by someone else" cases. */
	static strangerKey(): KeyObject {
		return keyPair().privateKey;
	}

	private clientData(type: string, challenge: string, o: CeremonyOverrides): Buffer {
		return Buffer.from(
			JSON.stringify({ type, challenge, origin: o.origin ?? this.origin, crossOrigin: false }),
		);
	}

	private authData(o: CeremonyOverrides, defaultFlags: number, attested?: Buffer): Buffer {
		const counter = Buffer.alloc(4);
		counter.writeUInt32BE(o.counter ?? 0);
		return Buffer.concat([
			sha256(o.rpId ?? this.rpId),
			Buffer.from([o.flags ?? defaultFlags]),
			counter,
			attested ?? Buffer.alloc(0),
		]);
	}

	register(challenge: string, o: CeremonyOverrides = {}): RegistrationResponseJSON {
		const idLen = Buffer.alloc(2);
		idLen.writeUInt16BE(this.credentialId.length);
		const attested = Buffer.concat([
			Buffer.alloc(16), // AAGUID
			idLen,
			this.credentialId,
			this.cosePublicKey(),
		]);
		const authData = this.authData(o, FLAG_UP | FLAG_UV | FLAG_AT, attested);
		const attestationObject = Buffer.concat([
			Buffer.from([0xa3]),
			cborText('fmt'),
			cborText('none'),
			cborText('attStmt'),
			Buffer.from([0xa0]),
			cborText('authData'),
			cborBytes(authData),
		]);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64u(this.clientData('webauthn.create', challenge, o)),
				attestationObject: b64u(attestationObject),
				transports: ['internal'],
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform',
		};
	}

	assert(challenge: string, userId: string, o: CeremonyOverrides = {}): AuthenticationResponseJSON {
		const clientDataJSON = this.clientData('webauthn.get', challenge, o);
		const authenticatorData = this.authData(o, FLAG_UP | FLAG_UV);
		const signature = sign(
			'sha256',
			Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
			o.signingKey ?? this.keys.privateKey,
		);
		const userHandle =
			o.userHandle === null ? undefined : (o.userHandle ?? b64u(Buffer.from(userId)));
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64u(clientDataJSON),
				authenticatorData: b64u(authenticatorData),
				signature: b64u(signature),
				userHandle,
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform',
		};
	}
}

export const FLAGS = { UP: FLAG_UP, UV: FLAG_UV, AT: FLAG_AT };
