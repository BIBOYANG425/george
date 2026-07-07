// tests/admin/router-auth.test.ts
// Covers the admin API auth gate (src/admin/router.ts) after the ?token= query
// branch was removed: header forms (Authorization: Bearer, x-admin-token) still
// authenticate; the ?token= query form is now rejected with 401.
//
// Targets GET /admin/api/models — its handler needs no Supabase, so a dummy client
// is fine and the test isolates the auth middleware.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import express from 'express'
import { createAdminDashboardRouter } from '../../src/admin/router.js'

const TOKEN = 'secret-admin-token'
let server: http.Server
let port: number

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  // Dummy Supabase — GET /admin/api/models never touches it.
  app.use(createAdminDashboardRouter({} as never, TOKEN))
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('admin API auth gate', () => {
  it('rejects the ?token= query form with 401', async () => {
    const res = await get(`/admin/api/models?token=${TOKEN}`)
    expect(res.status).toBe(401)
  })

  it('accepts the Authorization: Bearer header', async () => {
    const res = await get('/admin/api/models', { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    expect(res.body).toContain('choices')
  })

  it('accepts the x-admin-token header', async () => {
    const res = await get('/admin/api/models', { 'x-admin-token': TOKEN })
    expect(res.status).toBe(200)
    expect(res.body).toContain('choices')
  })

  it('rejects a request with no token', async () => {
    const res = await get('/admin/api/models')
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token in the header', async () => {
    const res = await get('/admin/api/models', { authorization: 'Bearer nope' })
    expect(res.status).toBe(401)
  })
})
