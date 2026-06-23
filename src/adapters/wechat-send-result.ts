// Interpreting WeChat custom/send results.
//
// WeChat's POST /cgi-bin/message/custom/send returns HTTP 200 with a JSON body
// like {"errcode":45015,"errmsg":"..."} even on failure. For UNSOLICITED
// outbound (shipping notifications, not replies to a recent inbound message),
// the recipient is usually outside the 48h customer-service window, so errcode
// 45015 is the COMMON case — and 43004 (not subscribed), 48001 (no permission)
// also surface here. Checking only the HTTP status marks undelivered messages
// as 'sent'. Treat any transport error OR non-zero errcode as a failure.

export interface WeChatSendResult {
  ok: boolean
  status: number
  errcode?: number
  errmsg?: string
}

export function isWeChatSendSuccess(r: WeChatSendResult): boolean {
  if (!r.ok) return false
  if (typeof r.errcode === 'number' && r.errcode !== 0) return false
  return true
}

export function assertWeChatSendOk(r: WeChatSendResult): void {
  if (!r.ok) {
    throw new Error(`WeChat custom/send HTTP ${r.status}`)
  }
  if (typeof r.errcode === 'number' && r.errcode !== 0) {
    throw new Error(
      `WeChat custom/send errcode ${r.errcode}: ${r.errmsg ?? ''}`,
    )
  }
}
