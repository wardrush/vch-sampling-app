/**
 * Key-pair JWT for the Snowflake SQL API v2. Addendum §4.4.
 *
 * Stateless by construction: no driver, no connection pool to keep warm across
 * cold starts, no VPC. A function signs a token and makes an HTTPS call.
 *
 * Two details are easy to get subtly wrong and expensive to debug at 2am
 * because Snowflake answers both with the same opaque 401:
 *
 *  - **The issuer is the *fingerprint of the public key*, DER/SPKI encoded**,
 *    not of the private key and not of the PEM text.
 *  - **The account identifier is uppercased and stripped of any region or
 *    cloud suffix.** `xy12345.us-east-1` is `XY12345`; `MYORG-MYACCT` stays
 *    whole, because the hyphenated org form carries no dotted suffix.
 */

import { createHash, createPrivateKey, createPublicKey, createSign } from 'node:crypto';

export interface KeyPairJwtConfig {
  /** Account identifier: `MYORG-MYACCT` or the legacy locator `xy12345`. */
  account: string;
  /** The Snowflake service user. */
  user: string;
  /** PKCS#8 PEM. Encrypted keys need `privateKeyPassphrase`. */
  privateKeyPem: string;
  privateKeyPassphrase?: string;
  /** Seconds. Snowflake caps this at one hour; 59 min leaves room for skew. */
  lifetimeSeconds?: number;
}

const DEFAULT_LIFETIME_S = 59 * 60;

/**
 * Uppercase, and drop anything after the first dot.
 *
 * Snowflake's account *locator* form carries region and cloud (`xy12345.us-east-1.aws`)
 * in the hostname but not in the JWT subject. The org form (`MYORG-MYACCT`)
 * has no dot and passes through untouched.
 */
export function qualifyAccount(account: string): string {
  const upper = account.toUpperCase();
  const dot = upper.indexOf('.');
  return dot === -1 ? upper : upper.slice(0, dot);
}

/** `SHA256:<base64>` over the DER/SPKI encoding of the *public* key. */
export function publicKeyFingerprint(privateKeyPem: string, passphrase?: string): string {
  const privateKey = createPrivateKey(
    passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem,
  );
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface SignedJwt {
  token: string;
  /** Epoch ms. The caller re-signs before this, never on a 401 retry loop. */
  expiresAtMs: number;
}

export function signKeyPairJwt(config: KeyPairJwtConfig, nowMs = Date.now()): SignedJwt {
  const account = qualifyAccount(config.account);
  const user = config.user.toUpperCase();
  const qualifiedUser = `${account}.${user}`;
  const fingerprint = publicKeyFingerprint(config.privateKeyPem, config.privateKeyPassphrase);

  const iat = Math.floor(nowMs / 1000);
  const lifetime = config.lifetimeSeconds ?? DEFAULT_LIFETIME_S;
  const exp = iat + lifetime;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: `${qualifiedUser}.${fingerprint}`,
      sub: qualifiedUser,
      iat,
      exp,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const privateKey = createPrivateKey(
    config.privateKeyPassphrase
      ? { key: config.privateKeyPem, passphrase: config.privateKeyPassphrase }
      : config.privateKeyPem,
  );
  const signature = b64url(signer.sign(privateKey));

  return { token: `${header}.${payload}.${signature}`, expiresAtMs: exp * 1000 };
}

/**
 * Caches a signed token for the life of a warm container and re-signs a minute
 * before expiry.
 *
 * Signing is ~1 ms, so this is not about speed — it is about not re-deriving
 * the key fingerprint on every one of a batch's statements, and about a clear
 * place to reason about token lifetime when a cold start and an expiry land in
 * the same second.
 */
export function createJwtProvider(
  config: KeyPairJwtConfig,
  now: () => number = Date.now,
): () => string {
  let cached: SignedJwt | null = null;
  const SKEW_MS = 60_000;
  return () => {
    const t = now();
    if (!cached || cached.expiresAtMs - SKEW_MS <= t) {
      cached = signKeyPairJwt(config, t);
    }
    return cached.token;
  };
}
