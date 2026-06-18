// scripts/build-ge-candidates.ts
// Builds the GE course candidate "ready sheet" (src/services/ge-candidates.ts).
// This is the SLOW, shared step — run it on a schedule (e.g. nightly), not per
// request. Writes data/ge-candidates.json.
//
//   pnpm tsx scripts/build-ge-candidates.ts                # default easy buckets
//   pnpm tsx scripts/build-ge-candidates.ts GE-A GE-C GE-H GESM

import 'dotenv/config'
import { buildGeCandidates } from '../src/services/ge-candidates.js'

const cats = process.argv.slice(2)
const categories = cats.length ? cats : ['GE-A', 'GE-C', 'GE-H']

console.log(`[build-ge-candidates] building for ${categories.join(', ')} ...`)
const t0 = Date.now()
const snap = await buildGeCandidates(categories)
console.log(
  `[build-ge-candidates] done: ${snap.courses.length} courses, ` +
    `${snap.courses.filter((c) => c.topProf?.rating != null).length} with RMP ratings, ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)}s → data/ge-candidates.json`,
)
