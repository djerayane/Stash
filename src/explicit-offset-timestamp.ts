export function normalizeExplicitOffsetTimestamp(value: string): string | undefined {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, "0"));
  const offsetHour = zone === "Z" ? 0 : Number(offsetHourText);
  const offsetMinute = zone === "Z" ? 0 : Number(offsetMinuteText);
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return undefined;
  const offset = (sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  const reconstructedLocal = new Date(instant + offset * 60_000);
  if (reconstructedLocal.getUTCFullYear() !== year
    || reconstructedLocal.getUTCMonth() + 1 !== month
    || reconstructedLocal.getUTCDate() !== day
    || reconstructedLocal.getUTCHours() !== hour
    || reconstructedLocal.getUTCMinutes() !== minute
    || reconstructedLocal.getUTCSeconds() !== second
    || reconstructedLocal.getUTCMilliseconds() !== millisecond) return undefined;
  return new Date(instant).toISOString();
}
