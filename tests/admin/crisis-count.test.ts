// tests/admin/crisis-count.test.ts
// GG3-4: GET /admin/api/review/crisis-count is a lightweight boot-badge probe that
// returns ONLY { count } from the distress queue — no flagged/fabrication/injection
// fan-out (that stays on /review). With the crisis radar gated OFF (default), the
// distress queue short-circuits without touching Supabase, so a dummy client is fine
// and the endpoint returns { count: 0 }.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createAdminDashboardRouter } from '../../src/admin/router.js';

const TOKEN = 'secret-admin-token';
let server: http.Server;
let port: number;

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Dummy Supabase — with the radar OFF, getDistressQueue never queries it.
  app.use(createAdminDashboardRouter({} as never, TOKEN));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /admin/api/review/crisis-count', () => {
  beforeEach(() => {
    delete process.env.GEORGE_CRISIS_RADAR_ENABLED; // ensure radar OFF
  });

  it('requires auth (401 without a token)', async () => {
    const res = await get('/admin/api/review/crisis-count');
    expect(res.status).toBe(401);
  });

  it('returns { count: 0 } when the radar is gated off', async () => {
    const res = await get('/admin/api/review/crisis-count', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ count: 0 });
  });
});
