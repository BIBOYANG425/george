// tests/agent/shipping-optout.test.ts
//
// Pins the inbound opt-out / opt-in command matcher: it must catch the
// documented "TD" / "退订" commands (and resume words) on a whole message, but
// NOT fire on ordinary conversation that merely contains one of the words.

import { describe, it, expect } from "vitest";
import {
  matchShippingControl,
  shippingControlReply,
} from "../../src/agent/shipping-optout.js";

describe("matchShippingControl", () => {
  it("matches the documented opt-out commands (case / spacing / punctuation insensitive)", () => {
    for (const t of ["TD", "td", "  TD ", "TD.", "退订", "退订！", "unsubscribe", "STOP"]) {
      expect(matchShippingControl(t)).toBe("opt_out");
    }
  });

  it("matches opt-in / resume commands", () => {
    for (const t of ["订阅", "恢复通知", "resubscribe", "START"]) {
      expect(matchShippingControl(t)).toBe("opt_in");
    }
  });

  it("does NOT fire when the keyword is part of a real sentence", () => {
    expect(matchShippingControl("can you tell me when to stop by the warehouse")).toBeNull();
    expect(matchShippingControl("我想退订单可以吗")).toBeNull();
    expect(matchShippingControl("start planning my courses")).toBeNull();
    expect(matchShippingControl("TD Bank near campus?")).toBeNull();
  });

  it("handles empty / nullish input", () => {
    expect(matchShippingControl("")).toBeNull();
    expect(matchShippingControl("   ")).toBeNull();
    expect(matchShippingControl(null)).toBeNull();
    expect(matchShippingControl(undefined)).toBeNull();
  });
});

describe("shippingControlReply", () => {
  it("confirms an opt-out that matched a student", () => {
    expect(shippingControlReply("opt_out", true)).toContain("已退订");
  });
  it("explains when no shipping record was found", () => {
    expect(shippingControlReply("opt_out", false)).toContain("没有集运通知");
    expect(shippingControlReply("opt_in", false)).toContain("没找到");
  });
  it("confirms a resume", () => {
    expect(shippingControlReply("opt_in", true)).toContain("已恢复");
  });
});
