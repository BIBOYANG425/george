// tests/jobs/guarded-cron.test.ts
// Unit tests for makeGuardedTick — the overlap guard + timing + tagged logging the
// two squad crons share. Tests the tick handler directly (no scheduling).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeGuardedTick } from '../../src/jobs/guarded-cron.js';

describe('makeGuardedTick', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('runs fn and logs a tagged completion', async () => {
    const fn = vi.fn(async () => {});
    await makeGuardedTick('squad-coordinator', fn)();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[squad-coordinator\] tick complete in \d+ms$/));
  });

  it('skips a tick while the previous one is still running (overlap guard)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fn = vi.fn(async () => { await gate; });
    const tick = makeGuardedTick('rereach-eval', fn);

    const first = tick(); // starts, awaits the gate → still running
    await tick(); // second tick sees running=true → skips
    expect(logSpy).toHaveBeenCalledWith('[rereach-eval] previous tick still running, skipping');
    expect(fn).toHaveBeenCalledTimes(1);

    release();
    await first;
    // After the first completes, a new tick runs again.
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('logs a tagged failure and clears the running flag so the next tick can run', async () => {
    const fn = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const tick = makeGuardedTick('squad-coordinator', fn);
    await tick();
    expect(errSpy).toHaveBeenCalledWith('[squad-coordinator] tick failed:', expect.any(Error));
    // running was reset in finally → the next tick runs.
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
