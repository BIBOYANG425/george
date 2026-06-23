// Inbound shipping-notification control commands.
//
// The shipping notifier (src/jobs/shipping-notifier.ts) skips students whose
// students.shipping_notif_opt_out is true, and the student UI tells people to
// "回复 TD 退订" — but nothing ever set the flag. This recognises the opt-out /
// opt-in command from a raw inbound message so the orchestrator can flip the
// flag BEFORE any LLM cost. Matching is strict (whole normalized message) to
// avoid a stray "stop" mid-conversation accidentally unsubscribing someone.

export type ShippingControl = "opt_out" | "opt_in";

const OPT_OUT = new Set([
  "td",
  "退订",
  "退订通知",
  "tuiding",
  "unsubscribe",
  "stop",
]);

const OPT_IN = new Set([
  "订阅",
  "订阅通知",
  "恢复通知",
  "resubscribe",
  "subscribe",
  "start",
]);

// Returns the control action iff the WHOLE message (trimmed, lowercased, with
// surrounding whitespace/punctuation stripped) is one of the keywords.
export function matchShippingControl(
  text: string | null | undefined,
): ShippingControl | null {
  if (!text) return null;
  const norm = text
    .trim()
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  if (!norm) return null;
  if (OPT_OUT.has(norm)) return "opt_out";
  if (OPT_IN.has(norm)) return "opt_in";
  return null;
}

// In-voice confirmation. `matched` = whether a student row was actually found
// and updated (false ⇒ no shipping record behind this handle).
export function shippingControlReply(
  action: ShippingControl,
  matched: boolean,
): string {
  if (action === "opt_out") {
    return matched
      ? "已退订集运通知 ✅ 不会再给你发包裹状态推送。想恢复回复「订阅」。包裹状态随时可在 uscbia.com「我的包裹」查看。"
      : "你目前没有集运通知可退订。如有问题联系 BIA 运营。";
  }
  return matched
    ? "已恢复集运通知 ✅ 包裹有新状态会提醒你。想退订回复「TD」。"
    : "没找到你的集运记录 —— 先在 uscbia.com 预报包裹后即可收到通知。";
}
