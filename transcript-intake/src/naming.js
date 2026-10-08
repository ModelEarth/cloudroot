/**
 * Date and HHMM for the branch name, derived from meetingStartTimestamp
 * (always UTC from the extension) converted to America/Los_Angeles - not
 * from when the post arrives at the Worker. See PLAN.md's "Decided" list.
 */

export function getDateAndHHMM(meetingStartTimestamp) {
  const when = new Date(meetingStartTimestamp);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(formatter.formatToParts(when).map((p) => [p.type, p.value]));
  // Some ICU implementations print midnight as "24" under hour12: false -
  // normalize so HHMM always reads 00-23, not 24.
  const hour = parts.hour === "24" ? "00" : parts.hour;

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hour}${parts.minute}`,
  };
}
