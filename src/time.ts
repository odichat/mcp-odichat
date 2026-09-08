/**
 * Timezone helpers for turning a naive local wall-clock time into an absolute
 * instant.
 *
 * Built on `Intl.DateTimeFormat`, which carries the full IANA database in the
 * runtime — no dependency, and DST transitions are handled by the zone data
 * rather than by a fixed offset.
 */

const NAIVE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** True when `tz` is a real IANA identifier, e.g. `America/Caracas`. */
export function isValidIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Reads a Date back out as wall-clock fields in the given zone. */
function partsInZone(date: Date, tz: string): Record<string, number> {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, number>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = Number(part.value);
      return acc;
    }, {});
}

/**
 * Converts a naive local datetime (`YYYY-MM-DDTHH:mm`, no offset) in `tz` to the
 * absolute instant it denotes.
 *
 * Works by guessing the instant as if the wall-clock fields were UTC, then
 * correcting by the difference between that guess and how it actually reads in
 * the zone. Iterated twice so a guess that lands on the far side of a DST
 * transition still converges.
 */
export function zonedToUtc(naiveLocal: string, tz: string): Date {
  if (!isValidIanaZone(tz)) {
    throw new Error(
      `"${tz}" is not a valid IANA timezone identifier. ` +
        `Use a full identifier such as America/Caracas or Europe/Madrid, ` +
        `not a country, city or abbreviation.`,
    );
  }

  const match = NAIVE_DATETIME.exec(naiveLocal);
  if (!match) {
    throw new Error(
      `"${naiveLocal}" is not a naive local datetime. ` +
        `Use YYYY-MM-DDTHH:mm with no timezone offset and no trailing Z — ` +
        `the timezone is supplied separately.`,
    );
  }

  const [, year, month, day, hour, minute, second] = match.map(
    Number,
  ) as number[];

  if (
    (hour as number) > 23 ||
    (minute as number) > 59 ||
    ((second as number) || 0) > 59
  ) {
    throw new Error(
      `"${naiveLocal}" has an out-of-range time. ` +
        `Hours are 00-23, minutes and seconds 00-59.`,
    );
  }

  const target = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    (second as number) || 0,
  );

  // Date.UTC normalises out-of-range fields instead of rejecting them, so
  // "2026-13-45" would silently become 2027-02-14. Round-trip the fields to
  // catch a typo'd month or a day that does not exist in that month, rather
  // than scheduling months away from what the caller asked for.
  const check = new Date(target);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== (month as number) - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`"${naiveLocal}" is not a real calendar date.`);
  }

  let ts = target;
  for (let i = 0; i < 2; i++) {
    const p = partsInZone(new Date(ts), tz);
    const readBack = Date.UTC(
      p.year as number,
      (p.month as number) - 1,
      p.day as number,
      // Intl can render midnight as hour 24 in some locales/zones.
      (p.hour as number) % 24,
      p.minute as number,
      p.second as number,
    );
    ts += target - readBack;
  }

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`"${naiveLocal}" is not a valid date.`);
  }
  return date;
}

/** Formats an instant as a human-readable local clock time, e.g. `10:00 AM`. */
export function formatLocalTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}
