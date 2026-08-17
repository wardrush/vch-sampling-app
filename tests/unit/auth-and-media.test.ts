/**
 * A5, A10 and A11 — media tickets, the session cookie, and the audit writer.
 */

import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  readSessionCookie,
  sessionCookieHeader,
  verifySessionToken,
} from '../../src/shared/auth/session.js';
import { hashToken, extractToken } from '../../src/shared/auth/token.js';
import { hashIp, AuditWriter } from '../../src/shared/auth/audit.js';
import {
  issueOfflineSession,
  offlineSessionState,
  offlineWindowDays,
} from '../../src/shared/auth/offline.js';
import { MediaTicketIssuer, commitMedia, verifyUploadGrant } from '../../src/server/media/tickets.js';
import { MemoryBlobStore, mediaKey } from '../../src/server/storage/blobs.js';
import { FakeSnowflake } from '../support/fake-snowflake.js';
import { createHash } from 'node:crypto';

const SECRET = 'session-secret-for-tests';

describe('A10 — session cookie', () => {
  it('round-trips claims', () => {
    const token = createSessionToken(
      { sub: 'thane', kind: 'token', surface: 'ingest', crew_org_id: null, display_name: 'Thane' },
      SECRET,
      3600,
    );
    const verdict = verifySessionToken(token, SECRET);
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.claims.sub).toBe('thane');
  });

  it('rejects a tampered payload', () => {
    const token = createSessionToken({ sub: 'thane', kind: 'token', surface: 'ingest' }, SECRET, 3600);
    const forged =
      Buffer.from(JSON.stringify({ sub: 'someone-else', kind: 'token', surface: 'admin', iat: 0, exp: 9e9 })).toString(
        'base64url',
      ) + token.slice(token.indexOf('.'));
    expect(verifySessionToken(forged, SECRET).valid).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken({ sub: 'thane', kind: 'token', surface: 'ingest' }, 'other', 3600);
    expect(verifySessionToken(token, SECRET)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', () => {
    const token = createSessionToken({ sub: 'thane', kind: 'token', surface: 'ingest' }, SECRET, 60, 0);
    expect(verifySessionToken(token, SECRET, 120_000)).toEqual({ valid: false, reason: 'expired' });
  });

  it('sets __Host-, HttpOnly, Secure and SameSite', () => {
    const header = sessionCookieHeader('abc', 3600);
    expect(header).toContain('__Host-vch_session=abc');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Domain=');
  });

  it('reads its cookie out of a crowded header', () => {
    expect(readSessionCookie('a=1; __Host-vch_session=xyz; b=2')).toBe('xyz');
    expect(readSessionCookie('a=1')).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });
});

describe('A10 — tokens', () => {
  it('hashes, and the hash is what a table would hold', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('pulls a token from the URL or a bearer header', () => {
    const fromUrl = new Request('https://x.test/ingest/aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(extractToken(fromUrl)).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const fromHeader = new Request('https://x.test/ingest', {
      headers: { authorization: 'Bearer tok-123' },
    });
    expect(extractToken(fromHeader)).toBe('tok-123');
    expect(extractToken(new Request('https://x.test/other'))).toBeNull();
  });
});

describe('A11 — audit and offline session', () => {
  it('hashes the IP rather than storing it', () => {
    const hashed = hashIp('203.0.113.9', 'salt');
    expect(hashed).not.toContain('203.0.113');
    expect(hashIp('203.0.113.9', 'salt')).toBe(hashed);
    expect(hashIp('203.0.113.9', 'other-salt')).not.toBe(hashed);
    expect(hashIp(null, 'salt')).toBeNull();
  });

  it('writes an audit row with a parsed detail payload', async () => {
    const sf = new FakeSnowflake();
    const writer = new AuditWriter({ snowflake: sf.asClient(), ipHashSalt: 'salt' });
    await writer.write({
      actor_ref: 'thane',
      actor_kind: 'token',
      surface: 'ingest',
      action: 'import_commit',
      entity_type: 'plan_import',
      entity_id: 'imp-1',
      detail: { rows: 312 },
      ip: '203.0.113.9',
    });

    const statement = sf.matching('CURATED.AUDIT_EVENT')[0]!;
    expect(statement.sql).toContain('PARSE_JSON(?)');
    expect(statement.binds).toContain('thane');
    expect(statement.binds).toContain(JSON.stringify({ rows: 312 }));
  });

  it('refuses to shorten the offline window below a week', () => {
    expect(offlineWindowDays({})).toBe(14);
    expect(offlineWindowDays({ offlineWindowDays: 10 })).toBe(10);
    // Designing for nightly sync means designing against multi-day offline;
    // a 2-day window strands a crew, so the floor holds.
    expect(offlineWindowDays({ offlineWindowDays: 2 })).toBe(7);
  });

  it('warns before it locks', () => {
    const start = Date.parse('2026-10-01T00:00:00Z');
    const session = issueOfflineSession(
      { device_id: 'd', sampler_person_id: 'p', crew_org_id: 'c' },
      {},
      start,
    );
    expect(offlineSessionState(session, start).state).toBe('valid');
    expect(offlineSessionState(session, start + 12 * 86_400_000).state).toBe('warn');
    expect(offlineSessionState(session, start + 15 * 86_400_000).state).toBe('locked');
  });
});

describe('A5 — media tickets', () => {
  const issuerOptions = (blobs: MemoryBlobStore) => ({
    blobs,
    baseUrl: 'https://vch.test',
    uploadSecret: 'upload-secret',
  });

  it('returns already_have when the hash is known, and never a URL', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put(mediaKey('aa'.repeat(32)), new Uint8Array([1]));
    const issuer = new MediaTicketIssuer(issuerOptions(blobs));

    const [ticket] = await issuer.issue([
      { media_id: 'm1', content_hash: 'aa'.repeat(32) } as never,
    ]);
    expect(ticket!.action).toBe('already_have');
    expect(ticket).not.toHaveProperty('url');
  });

  it('deduplicates within one batch', async () => {
    const issuer = new MediaTicketIssuer(issuerOptions(new MemoryBlobStore()));
    const tickets = await issuer.issue([
      { media_id: 'm1', content_hash: 'bb'.repeat(32) } as never,
      { media_id: 'm2', content_hash: 'bb'.repeat(32) } as never,
    ]);
    expect(tickets[0]!.action).toBe('upload');
    expect(tickets[1]!.action).toBe('already_have');
  });

  it('signs a grant the upload endpoint can verify, and that expires', async () => {
    const issuer = new MediaTicketIssuer(issuerOptions(new MemoryBlobStore()));
    const tickets = await issuer.issue([
      { media_id: 'm1', content_hash: 'cc'.repeat(32) } as never,
    ]);
    const ticket = tickets[0];
    if (!ticket || ticket.action !== 'upload') {
      expect.unreachable('an unknown hash must get an upload ticket');
      return;
    }

    const url = new URL(ticket.url);
    const expires = Number(url.searchParams.get('expires'));
    const grant = url.searchParams.get('grant')!;

    expect(verifyUploadGrant('upload-secret', 'm1', 'cc'.repeat(32), expires, grant, Date.now())).toBe(true);
    expect(verifyUploadGrant('upload-secret', 'm2', 'cc'.repeat(32), expires, grant, Date.now())).toBe(false);
    expect(verifyUploadGrant('wrong-secret', 'm1', 'cc'.repeat(32), expires, grant, Date.now())).toBe(false);
    expect(verifyUploadGrant('upload-secret', 'm1', 'cc'.repeat(32), expires, grant, expires + 1)).toBe(false);
  });
});

describe('A5 — media commit verification', () => {
  it('fails the commit on a hash mismatch so the client re-uploads', async () => {
    const blobs = new MemoryBlobStore();
    const claimed = 'dd'.repeat(32);
    await blobs.put(mediaKey(claimed), new TextEncoder().encode('not what was promised'));

    const result = await commitMedia(
      { media_id: 'm1', content_hash: `sha256:${claimed}`, bytes: 21 },
      { blobs, markUploaded: async () => expect.unreachable('must not mark a corrupt object uploaded') },
    );

    expect(result.upload_state).toBe('failed');
    expect(result.code).toBe('HASH_MISMATCH');
    expect(result.retryable).toBe(true);
  });

  it('marks uploaded when the stored bytes verify', async () => {
    const blobs = new MemoryBlobStore();
    const bytes = new TextEncoder().encode('a real photo');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await blobs.put(mediaKey(hash), bytes);

    let marked = false;
    const result = await commitMedia(
      { media_id: 'm1', content_hash: `sha256:${hash}`, bytes: bytes.byteLength },
      { blobs, markUploaded: async () => { marked = true; } },
    );

    expect(result).toMatchObject({ upload_state: 'uploaded', verified: true });
    expect(marked).toBe(true);
  });

  it('reports a missing object as retryable rather than corrupt', async () => {
    const result = await commitMedia(
      { media_id: 'm1', content_hash: `sha256:${'ee'.repeat(32)}`, bytes: 10 },
      { blobs: new MemoryBlobStore(), markUploaded: async () => {} },
    );
    expect(result.code).toBe('OBJECT_MISSING');
    expect(result.retryable).toBe(true);
  });
});
