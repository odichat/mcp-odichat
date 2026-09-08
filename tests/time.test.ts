import { describe, expect, test } from "bun:test";
import { formatLocalTime, isValidIanaZone, zonedToUtc } from "@/time.ts";

describe("isValidIanaZone", () => {
  test("accepts real identifiers", () => {
    expect(isValidIanaZone("America/Caracas")).toBe(true);
    expect(isValidIanaZone("Asia/Kolkata")).toBe(true);
    expect(isValidIanaZone("UTC")).toBe(true);
  });

  test("rejects country names and abbreviations", () => {
    expect(isValidIanaZone("Venezuela")).toBe(false);
    expect(isValidIanaZone("EST5EDT/nope")).toBe(false);
    expect(isValidIanaZone("")).toBe(false);
  });
});

describe("zonedToUtc", () => {
  test("applies a fixed offset", () => {
    // Caracas is UTC-4 year round.
    expect(
      zonedToUtc("2026-09-08T10:00", "America/Caracas").toISOString(),
    ).toBe("2026-09-08T14:00:00.000Z");
  });

  test("applies a half-hour offset", () => {
    expect(zonedToUtc("2026-09-08T10:00", "Asia/Kolkata").toISOString()).toBe(
      "2026-09-08T04:30:00.000Z",
    );
  });

  test("respects DST on both sides of a transition", () => {
    // Same wall-clock time, different UTC instants: EDT in July, EST in January.
    expect(
      zonedToUtc("2026-07-08T10:00", "America/New_York").toISOString(),
    ).toBe("2026-07-08T14:00:00.000Z");
    expect(
      zonedToUtc("2026-01-08T10:00", "America/New_York").toISOString(),
    ).toBe("2026-01-08T15:00:00.000Z");
  });

  test("handles a southern-hemisphere zone whose DST runs the other way", () => {
    expect(
      zonedToUtc("2026-01-15T12:00", "Australia/Sydney").toISOString(),
    ).toBe("2026-01-15T01:00:00.000Z");
    expect(
      zonedToUtc("2026-07-15T12:00", "Australia/Sydney").toISOString(),
    ).toBe("2026-07-15T02:00:00.000Z");
  });

  test("accepts optional seconds and a space separator", () => {
    expect(zonedToUtc("2026-09-08T10:00:30", "UTC").toISOString()).toBe(
      "2026-09-08T10:00:30.000Z",
    );
    expect(zonedToUtc("2026-09-08 10:00", "UTC").toISOString()).toBe(
      "2026-09-08T10:00:00.000Z",
    );
  });

  test("handles midnight, which Intl can render as hour 24", () => {
    expect(
      zonedToUtc("2026-09-08T00:00", "America/Caracas").toISOString(),
    ).toBe("2026-09-08T04:00:00.000Z");
  });

  test("rejects a value carrying its own offset", () => {
    expect(() => zonedToUtc("2026-09-08T10:00:00Z", "UTC")).toThrow(
      "is not a naive local datetime",
    );
    expect(() => zonedToUtc("2026-09-08T10:00-04:00", "UTC")).toThrow(
      "is not a naive local datetime",
    );
  });

  test("rejects an unparseable value", () => {
    expect(() => zonedToUtc("tomorrow at ten", "UTC")).toThrow(
      "is not a naive local datetime",
    );
  });

  test("rejects an invalid timezone", () => {
    expect(() => zonedToUtc("2026-09-08T10:00", "Venezuela")).toThrow(
      "is not a valid IANA timezone identifier",
    );
  });

  test("rejects an impossible date instead of rolling it over", () => {
    // Date.UTC would normalise this to 2027-02-14 rather than reject it.
    expect(() => zonedToUtc("2026-13-45T10:00", "UTC")).toThrow(
      "is not a real calendar date",
    );
    expect(() => zonedToUtc("2026-02-30T10:00", "UTC")).toThrow(
      "is not a real calendar date",
    );
  });

  test("rejects an out-of-range time", () => {
    expect(() => zonedToUtc("2026-09-08T25:00", "UTC")).toThrow(
      "has an out-of-range time",
    );
    expect(() => zonedToUtc("2026-09-08T10:99", "UTC")).toThrow(
      "has an out-of-range time",
    );
  });

  test("still accepts the last day of a month", () => {
    expect(zonedToUtc("2026-02-28T10:00", "UTC").toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(zonedToUtc("2028-02-29T10:00", "UTC").toISOString()).toBe(
      "2028-02-29T10:00:00.000Z",
    );
  });
});

describe("formatLocalTime", () => {
  test("renders the contact's local clock time, not UTC", () => {
    const instant = new Date("2026-09-08T14:00:00Z");
    expect(formatLocalTime(instant, "America/Caracas")).toBe("10:00 AM");
    expect(formatLocalTime(instant, "UTC")).toBe("2:00 PM");
  });
});
