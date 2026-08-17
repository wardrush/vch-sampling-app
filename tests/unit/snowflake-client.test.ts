/**
 * A1 — the Snowflake SQL API client.
 *
 * Exercised against a simulated SQL API rather than a mock of itself: the
 * things worth checking here are the 202-poll, the partition follow, and the
 * stable `requestId` on retry, and none of those is visible from a stubbed
 * `execute`.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SnowflakeClient, asObjects, toBinding } from '../../src/shared/snowflake/client.js';
import { publicKeyFingerprint, qualifyAccount, signKeyPairJwt } from '../../src/shared/snowflake/jwt.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const config = {
  account: 'xy12345.us-east-1',
  user: 'svc_sampling',
  privateKeyPem: privateKey,
  host: 'xy12345.snowflakecomputing.com',
  sleep: async () => {},
};

describe('key-pair JWT', () => {
  it('strips the region from the account identifier', () => {
    expect(qualifyAccount('xy12345.us-east-1.aws')).toBe('XY12345');
    expect(qualifyAccount('myorg-myacct')).toBe('MYORG-MYACCT');
  });

  it('issues iss as ACCOUNT.USER.SHA256:fingerprint over the public key', () => {
    const { token } = signKeyPairJwt({ account: 'xy12345.us-east-1', user: 'svc', privateKeyPem: privateKey });
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
      iss: string;
      sub: string;
    };
    expect(claims.sub).toBe('XY12345.SVC');
    expect(claims.iss).toBe(`XY12345.SVC.${publicKeyFingerprint(privateKey)}`);
  });
});

describe('bindings', () => {
  it('types values the way the SQL API expects', () => {
    expect(toBinding('x')).toEqual({ type: 'TEXT', value: 'x' });
    expect(toBinding(3)).toEqual({ type: 'FIXED', value: '3' });
    expect(toBinding(3.5)).toEqual({ type: 'REAL', value: '3.5' });
    expect(toBinding(true)).toEqual({ type: 'BOOLEAN', value: 'true' });
    expect(toBinding(null)).toEqual({ type: 'TEXT', value: null });
    expect(toBinding(undefined)).toEqual({ type: 'TEXT', value: null });
  });

  it('refuses a non-finite number rather than binding "NaN"', () => {
    expect(() => toBinding(Number.NaN)).toThrow();
  });
});

describe('execute', () => {
  it('polls a 202 until the statement completes', async () => {
    let calls = 0;
    const client = new SnowflakeClient({
      ...config,
      fetch: async (input) => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ statementHandle: 'h1' }), { status: 202 });
        }
        if (calls === 2) return new Response(null, { status: 202 });
        expect(String(input)).toContain('/statements/h1');
        return new Response(
          JSON.stringify({
            statementHandle: 'h1',
            data: [['a', '1']],
            resultSetMetaData: { rowType: [{ name: 'NAME', type: 'TEXT' }, { name: 'N', type: 'FIXED' }] },
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.execute('SELECT 1');
    expect(asObjects(result)).toEqual([{ name: 'a', n: '1' }]);
    expect(calls).toBe(3);
  });

  it('follows every partition, not just the first', async () => {
    const client = new SnowflakeClient({
      ...config,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('partition=1')) {
          return new Response(JSON.stringify({ data: [['second']] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            statementHandle: 'h1',
            data: [['first']],
            resultSetMetaData: {
              rowType: [{ name: 'V', type: 'TEXT' }],
              partitionInfo: [{ rowCount: 1, uncompressedSize: 1 }, { rowCount: 1, uncompressedSize: 1 }],
            },
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.execute('SELECT v');
    expect(result.rows).toEqual([['first'], ['second']]);
  });

  it('reuses the requestId across retries so a committed statement is not re-run', async () => {
    const requestIds: string[] = [];
    let attempt = 0;
    const client = new SnowflakeClient({
      ...config,
      fetch: async (input) => {
        attempt += 1;
        const url = new URL(String(input));
        requestIds.push(url.searchParams.get('requestId')!);
        if (attempt === 1) return new Response('{}', { status: 503 });
        expect(url.searchParams.get('retry')).toBe('true');
        return new Response(JSON.stringify({ statementHandle: 'h', data: [] }), { status: 200 });
      },
    });

    await client.execute('MERGE INTO t USING s ON 1=1');
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  it('does not retry a non-retryable status', async () => {
    let attempts = 0;
    const client = new SnowflakeClient({
      ...config,
      fetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ code: '002003', message: 'no such table' }), { status: 422 });
      },
    });

    await expect(client.execute('SELECT 1')).rejects.toThrow('no such table');
    expect(attempts).toBe(1);
  });
});
