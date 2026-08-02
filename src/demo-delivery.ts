/**
 * Produces the deterministic delivery estimate shown by the configured demo
 * checkout. The estimate is thirty minutes before the employee's requested
 * deadline, with a stable fallback for deadlines that contain no clock time.
 */
export function demoDeliveryEstimate(
  requestedDeadline: string | null | undefined,
): string {
  const normalized = requestedDeadline?.trim() ?? "";
  const match = normalized.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  );
  if (!match) return "7:30 AM tomorrow";

  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return "7:30 AM tomorrow";
  }

  const meridiem = match[3]?.toLowerCase().startsWith("p") ? "pm" : "am";
  const requestedMinutes =
    (hour % 12) * 60 + minute + (meridiem === "pm" ? 12 * 60 : 0);
  const estimateMinutes = (requestedMinutes - 30 + 24 * 60) % (24 * 60);
  const estimateHour24 = Math.floor(estimateMinutes / 60);
  const estimateMinute = estimateMinutes % 60;
  const estimateHour12 = estimateHour24 % 12 || 12;
  const estimateMeridiem = estimateHour24 >= 12 ? "PM" : "AM";

  const lower = normalized.toLowerCase();
  const day = lower.includes("today")
    ? "today"
    : lower.includes("tomorrow")
      ? requestedMinutes < 30
        ? "today"
        : "tomorrow"
      : "tomorrow";

  return `${estimateHour12}:${String(estimateMinute).padStart(2, "0")} ${estimateMeridiem} ${day}`;
}
