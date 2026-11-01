/**
 * Date helpers for calendar tools. Dates are "YYYY-MM-DD" and times "HH:MM"
 * (24-hour), always meaning wall-clock time in the user's time zone. Google
 * Calendar resolves wall-clock times itself when given a timeZone, so the only
 * offset math needed is for query ranges (start of a local day as an instant).
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_PER_DAY = 24 * 60;

export function isValidDate(date: string): boolean {
	const match = DATE_PATTERN.exec(date);
	if (!match) return false;
	const [, y, m, d] = match.map(Number) as [number, number, number, number];
	const parsed = new Date(Date.UTC(y, m - 1, d));
	return (
		parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
	);
}

export function isValidTime(time: string): boolean {
	return TIME_PATTERN.test(time);
}

export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function minutesOfDay(time: string): number {
	const [h, m] = time.split(":").map(Number) as [number, number];
	return h * 60 + m;
}

/** Adds minutes to a local date and time, rolling over midnight as needed. */
export function addMinutes(
	date: string,
	time: string,
	minutes: number,
): { date: string; time: string } {
	const total = minutesOfDay(time) + minutes;
	const dayShift = Math.floor(total / MINUTES_PER_DAY);
	const inDay = total - dayShift * MINUTES_PER_DAY;
	const hh = String(Math.floor(inDay / 60)).padStart(2, "0");
	const mm = String(inDay % 60).padStart(2, "0");
	return { date: addDays(date, dayShift), time: `${hh}:${mm}` };
}

/** Today's date in the given time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
	return localParts(now, timeZone).date;
}

/** The local date and time of an instant in the given time zone. */
export function localParts(instant: Date, timeZone: string): { date: string; time: string } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(instant)
			.map((part) => [part.type, part.value]),
	);
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour}:${parts.minute}`,
	};
}

/** The instant (ISO, UTC) at which a local date starts in the given time zone. Handles DST. */
export function startOfLocalDay(date: string, timeZone: string): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const wallClockAsUtc = Date.UTC(y, m - 1, d);
	// Correct twice: the offset at the guessed instant can differ across a DST change.
	let instant = wallClockAsUtc - offsetMs(new Date(wallClockAsUtc), timeZone);
	instant = wallClockAsUtc - offsetMs(new Date(instant), timeZone);
	return new Date(instant).toISOString();
}

/** The time zone's UTC offset at an instant, in milliseconds (e.g. -5h for EST). */
function offsetMs(instant: Date, timeZone: string): number {
	const { date, time } = localParts(instant, timeZone);
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const [h, min] = time.split(":").map(Number) as [number, number];
	const localAsUtc = Date.UTC(y, m - 1, d, h, min);
	const instantToMinute = Math.floor(instant.getTime() / 60_000) * 60_000;
	return localAsUtc - instantToMinute;
}

/** "7 PM", "7:30 PM", "12 PM". */
export function speakTime(time: string): string {
	const [h, m] = time.split(":").map(Number) as [number, number];
	const suffix = h < 12 ? "AM" : "PM";
	const hour12 = h % 12 === 0 ? 12 : h % 12;
	return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "today", "tomorrow", or e.g. "Thursday, November 6". */
export function speakDay(date: string, today: string): string {
	if (date === today) return "today";
	if (date === addDays(today, 1)) return "tomorrow";
	return longDate(date);
}

/** e.g. "Thursday, November 6" (adds the year only if it isn't the current one). */
export function longDate(date: string, currentYear?: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const showYear = currentYear !== undefined && y !== currentYear;
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		weekday: "long",
		month: "long",
		day: "numeric",
		...(showYear ? { year: "numeric" } : {}),
	}).format(new Date(Date.UTC(y, m - 1, d)));
}
