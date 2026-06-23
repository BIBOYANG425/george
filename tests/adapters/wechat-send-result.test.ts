// tests/adapters/wechat-send-result.test.ts
//
// Pins the WeChat send-result interpretation: HTTP-200-with-errcode is WeChat's
// primary failure shape (45015 = out of 48h window), and an unsolicited
// shipping notification must surface that as a failure, never a false 'sent'.

import { describe, it, expect } from 'vitest'
import {
  isWeChatSendSuccess,
  assertWeChatSendOk,
} from '../../src/adapters/wechat-send-result.js'

describe('isWeChatSendSuccess', () => {
  it('is true only for ok + errcode 0 (or absent)', () => {
    expect(isWeChatSendSuccess({ ok: true, status: 200, errcode: 0 })).toBe(true)
    expect(isWeChatSendSuccess({ ok: true, status: 200 })).toBe(true)
  })

  it('is false on a non-zero errcode despite HTTP 200', () => {
    expect(isWeChatSendSuccess({ ok: true, status: 200, errcode: 45015 })).toBe(
      false,
    )
    expect(isWeChatSendSuccess({ ok: true, status: 200, errcode: 43004 })).toBe(
      false,
    )
  })

  it('is false on a transport error', () => {
    expect(isWeChatSendSuccess({ ok: false, status: 500, errcode: 0 })).toBe(
      false,
    )
  })
})

describe('assertWeChatSendOk', () => {
  it('does not throw on a clean success', () => {
    expect(() =>
      assertWeChatSendOk({ ok: true, status: 200, errcode: 0 }),
    ).not.toThrow()
    expect(() => assertWeChatSendOk({ ok: true, status: 200 })).not.toThrow()
  })

  it('throws with the errcode on HTTP-200-with-errcode (the silent-drop bug)', () => {
    expect(() =>
      assertWeChatSendOk({ ok: true, status: 200, errcode: 45015, errmsg: 'oob' }),
    ).toThrow(/45015/)
  })

  it('throws on a transport (non-2xx) error', () => {
    expect(() =>
      assertWeChatSendOk({ ok: false, status: 502 }),
    ).toThrow(/HTTP 502/)
  })
})
