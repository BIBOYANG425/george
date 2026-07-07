import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// SANCTIONED GUARD — george is NOT the Supabase schema owner. The canonical
// migrations live in bia-admin/supabase/migrations (george's local copies were
// archived there under docs/schema-history/george/ and deleted in GG6). If a
// supabase/migrations/ tree reappears in this repo, the ownership split has
// drifted back and this test fails deliberately. See CLAUDE.md ("Not the
// Supabase schema owner").
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('schema ownership — george ships no local Supabase migrations', () => {
  it('supabase/migrations/ must not reappear (bia-admin owns the schema)', () => {
    expect(existsSync(resolve(repoRoot, 'supabase', 'migrations'))).toBe(false)
  })

  it('the supabase/ directory itself stays absent', () => {
    expect(existsSync(resolve(repoRoot, 'supabase'))).toBe(false)
  })
})
