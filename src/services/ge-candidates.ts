// src/services/ge-candidates.ts
//
// "Ready sheet" for course recs. The SHARED facts — which GE courses exist, their
// professor, that professor's RateMyProfessors rating, and open status — are the
// SAME for every student, but fetching them live means chaining search_ge_courses
// + get_rmp_ratings across up to 8 GE categories (~30s) or calling the 45s
// server-side recommender. So we build that shared set ONCE (a script/cron), and
// at query time George reads it instantly and personalizes the picks from the
// student's own profile.
//
//   buildGeCandidates() — SLOW, shared. Run by scripts/build-ge-candidates.ts (or a cron).
//   readGeCandidates()  — FAST per-request read the ge_candidates tool serves.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = path.resolve(__dirname, '../../data/ge-candidates.json')

export const GE_CATEGORIES = ['GE-A', 'GE-B', 'GE-C', 'GE-D', 'GE-E', 'GE-F', 'GE-G', 'GE-H', 'GESM'] as const

export interface CandidateProf {
  name: string
  open: boolean
  rating: number | null
  difficulty: number | null
  wouldTakeAgain: number | null
  numRatings: number | null
}
export interface CandidateCourse {
  code: string // "AMST 101mgw"
  title: string
  units: string
  category: string
  topProf: CandidateProf | null // best-rated prof teaching it this term
}
export interface GeSnapshot {
  builtAt: string
  categories: string[]
  courses: CandidateCourse[]
}

interface RawSection { instructor?: { firstName?: string; lastName?: string }; isClosed?: boolean }
interface RawCourse { department: string; number: string; title: string; units?: string; sections?: RawSection[] }
interface RmpRecord { avgRating?: number; avgDifficulty?: number; numRatings?: number; wouldTakeAgainPercent?: number }

const fullName = (s?: { firstName?: string; lastName?: string }): string =>
  [s?.firstName, s?.lastName].filter(Boolean).join(' ').trim()

async function fetchCategory(category: string): Promise<RawCourse[]> {
  const res = await fetch(`${config.biaRoommate.baseUrl}/api/courses/ge?category=${encodeURIComponent(category)}`, {
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) throw new Error(`ge fetch ${category} failed ${res.status}`)
  return (await res.json()) as RawCourse[]
}

async function fetchRmp(names: string[]): Promise<Record<string, RmpRecord | null>> {
  const out: Record<string, RmpRecord | null> = {}
  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50)
    try {
      const res = await fetch(`${config.biaRoommate.baseUrl}/api/rmp/batch?names=${encodeURIComponent(chunk.join(','))}`, {
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { ratings?: Record<string, RmpRecord | null> }
        Object.assign(out, data.ratings ?? {})
      }
    } catch {
      /* skip a failed chunk; those profs just get null ratings */
    }
  }
  return out
}

// Build the snapshot (SLOW, shared). Defaults to the common "easy GE" buckets for
// the prototype; pass categories to widen. maxProfs caps RMP lookups to bound time.
export async function buildGeCandidates(
  categories: readonly string[] = ['GE-A', 'GE-C', 'GE-H'],
  maxProfs = 150,
): Promise<GeSnapshot> {
  const byCat: Array<{ category: string; raw: RawCourse[] }> = []
  const allNames = new Set<string>()
  for (const category of categories) {
    const raw = await fetchCategory(category)
    byCat.push({ category, raw })
    for (const c of raw) for (const s of c.sections ?? []) {
      const n = fullName(s.instructor)
      if (n) allNames.add(n)
    }
  }
  const rmp = await fetchRmp(Array.from(allNames).slice(0, maxProfs))

  const courses: CandidateCourse[] = []
  for (const { category, raw } of byCat) {
    for (const c of raw) {
      let best: CandidateProf | null = null
      for (const s of c.sections ?? []) {
        const name = fullName(s.instructor)
        if (!name) continue
        const r = rmp[name] ?? null
        const prof: CandidateProf = {
          name,
          open: !s.isClosed,
          rating: r?.avgRating ?? null,
          difficulty: r?.avgDifficulty ?? null,
          wouldTakeAgain: r?.wouldTakeAgainPercent ?? null,
          numRatings: r?.numRatings ?? null,
        }
        if (!best || (prof.rating ?? -1) > (best.rating ?? -1)) best = prof
      }
      courses.push({ code: `${c.department} ${c.number}`, title: c.title, units: c.units ?? '', category, topProf: best })
    }
  }
  courses.sort((a, b) => (b.topProf?.rating ?? -1) - (a.topProf?.rating ?? -1))

  const snapshot: GeSnapshot = { builtAt: new Date().toISOString(), categories: [...categories], courses }
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true })
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot))
  return snapshot
}

let _cache: GeSnapshot | null = null
function load(): GeSnapshot | null {
  if (_cache) return _cache
  try {
    _cache = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8')) as GeSnapshot
  } catch {
    _cache = null
  }
  return _cache
}

// FAST per-request read: the top-rated candidates (optionally one category). This
// is broad on purpose — George personalizes/orders the picks from the profile.
export function readGeCandidates(opts: { category?: string; limit?: number } = {}): {
  builtAt: string | null
  courses: CandidateCourse[]
} {
  const snap = load()
  if (!snap) return { builtAt: null, courses: [] }
  let courses = snap.courses
  if (opts.category) {
    const u = opts.category.trim().toUpperCase()
    const cat = u === 'GESM' ? 'GESM' : `GE-${u.replace(/^GE-?/, '')}`
    courses = courses.filter((c) => c.category === cat)
  }
  return { builtAt: snap.builtAt, courses: courses.slice(0, opts.limit ?? 25) }
}
