/**
 * A10 — the signed session cookie.
 *
 * Plan v02 §8: the token URL is exchanged **immediately** for a signed httpOnly
 * session cookie. That exchange is the whole point of the phasing — when the
 * shared IdP lands, only the step that establishes this session changes, and
 * every request path downstream is untouched. A token carried on every request
 * would make the IdP a rewrite instead of a swap.
 *
 * The cookie is a compact HMAC-signed JWS-shaped value rather than a JWT: there
 * is one issuer, one audience and one algorithm, so the `alg` header field
 * would only ever be an attack surface.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-vch_session';

export type ActorKind = 'token' | 'idp_user' | 'service';

export interface SessionClaims {
  /** `person_ref` in MVP; a real `person_id` after the IdP. */
  sub: string;
  kind: ActorKind;
  surface: 'ingest' | 'sampler' | 'analyst' | 'admin';
  crew_org_id?: string | null;
  display_name?: string | null;
  /** Epoch seconds. */
  iat: number;
  exp: number;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function createSessionToken(
  claims: Omit<SessionClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const full: SessionClaims = { ...claims, iat, exp: iat + ttlSeconds };
  const body = b64url(JSON.stringify(full));
  return `${body}.${sign(secret, body)}`;
}

export type SessionVerdict =
  | { valid: true; claims: SessionClaims }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifySessionToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): SessionVerdict {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { valid: false, reason: 'malformed' };

  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, body));
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length of an HMAC is not a secret.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}

/**
 * `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
 *
 * `__Host-` is not decoration: it forbids `Domain`, which is what stops a
 * sibling host on the same registrable domain from setting this cookie.
 * `SameSite=Lax` still allows the token URL's own top-level navigation to
 * arrive with the cookie set, which is the flow §9 of the ingest spec
 * describes.
 */
export function sessionCookieHeader(token: string, ttlSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ].join('; ');
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The one call a function makes to find out who is asking. */
export function requireSession(
  request: Request,
  secret: string,
  nowMs = Date.now(),
): SessionClaims | null {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (!token) return null;
  const verdict = verifySessionToken(token, secret, nowMs);
  return verdict.valid ? verdict.claims : null;
}
