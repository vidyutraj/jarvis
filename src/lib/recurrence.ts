import { z } from "zod";
import { addDays, isValidDate, longDate, startOfLocalDay } from "./dates";

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WEEKDAY_NAMES: Record<Weekday, string> = {
	SU: "Sunday",
	MO: "Monday",
	TU: "Tuesday",
	WE: "Wednesday",
	TH: "Thursday",
	FR: "Friday",
	SA: "Saturday",
};
type Weekday = (typeof WEEKDAYS)[number];

const UNITS = { daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const;

export const repeatSchema = z
	.object({
		frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
		interval: z
			.number()
			.int()
			.min(1)
			.max(30)
			.optional()
			.describe("Every N days/weeks/months/years. Defaults to 1."),
		days_of_week: z
			.array(z.enum(WEEKDAYS))
			.min(1)
			.max(7)
			.optional()
			.describe(
				"Weekly only: which days, e.g. ['MO','WE']. Defaults to the start date's day.",
			),
		until: z
			.string()
			.refine(isValidDate, "Use a real date as YYYY-MM-DD.")
			.optional()
			.describe("Last date it can happen, YYYY-MM-DD (inclusive)."),
		count: z
			.number()
			.int()
			.min(1)
			.max(366)
			.optional()
			.describe("Total number of times. Use either until or count, not both."),
	})
	.describe("Only for repeating events. Omit for a one-off event.");

export type RepeatRule = z.output<typeof repeatSchema>;

export function weekdayOf(date: string): Weekday {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/**
 * Google counts the start date as the first occurrence even if it isn't one of
 * the chosen weekdays, so move the start to the first chosen weekday on or after it.
 */
export function firstOccurrence(date: string, rule: RepeatRule): string {
	if (rule.frequency !== "weekly" || !rule.days_of_week) return date;
	for (let offset = 0; offset < 7; offset++) {
		const candidate = addDays(date, offset);
		if (rule.days_of_week.includes(weekdayOf(candidate))) return candidate;
	}
	return date;
}

/** Problems Claude should fix before calling again, or null if the rule is fine. */
export function validateRepeat(rule: RepeatRule, startDate: string): string | null {
	if (rule.until && rule.count)
		return "Give either an end date or a number of times for the repeat, not both.";
	if (rule.until && rule.until < startDate)
		return "The repeat can't end before the event starts.";
	if (rule.days_of_week && rule.frequency !== "weekly")
		return "Days of the week only work with a weekly repeat.";
	return null;
}

/**
 * RFC 5545 RRULE line. For timed events UNTIL must be a UTC instant, so it's the
 * end of the "until" day in the user's time zone; all-day events use a plain date.
 */
export function buildRrule(
	rule: RepeatRule,
	options: { allDay: boolean; timeZone: string },
): string {
	const parts = [`FREQ=${rule.frequency.toUpperCase()}`];
	if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.frequency === "weekly" && rule.days_of_week)
		parts.push(`BYDAY=${rule.days_of_week.join(",")}`);
	if (rule.count) parts.push(`COUNT=${rule.count}`);
	if (rule.until) parts.push(`UNTIL=${untilValue(rule.until, options)}`);
	return `RRULE:${parts.join(";")}`;
}

/** e.g. "every week on Monday and Wednesday until Tuesday, December 15", "every 2 days, 10 times". */
export function speakRepeat(rule: RepeatRule, startDate: string): string {
	const interval = rule.interval ?? 1;
	const unit = UNITS[rule.frequency];
	let text = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
	if (rule.frequency === "weekly") {
		const days = (rule.days_of_week ?? [weekdayOf(startDate)]).map((day) => WEEKDAY_NAMES[day]);
		const joined =
			days.length === 1
				? days[0]
				: `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
		text = interval === 1 ? `every ${joined}` : `every ${interval} weeks on ${joined}`;
	}
	if (rule.until) text += ` until ${longDate(rule.until)}`;
	if (rule.count) text += `, ${rule.count} ${rule.count === 1 ? "time" : "times"}`;
	return text;
}

/**
 * Ends a series after `lastDate` (inclusive), keeping its other rules and any
 * exceptions. Replaces an existing end date or count.
 */
export function endRecurrence(
	lines: string[],
	lastDate: string,
	options: { allDay: boolean; timeZone: string },
): string[] {
	return lines.map((line) => {
		if (!line.startsWith("RRULE:")) return line;
		const parts = line
			.slice("RRULE:".length)
			.split(";")
			.filter((part) => !part.startsWith("UNTIL=") && !part.startsWith("COUNT="));
		return `RRULE:${[...parts, `UNTIL=${untilValue(lastDate, options)}`].join(";")}`;
	});
}

/** RRULE UNTIL: a plain date for all-day series; otherwise the end of that local day, in UTC. */
function untilValue(date: string, options: { allDay: boolean; timeZone: string }): string {
	if (options.allDay) return date.replaceAll("-", "");
	const endOfDay = new Date(
		Date.parse(startOfLocalDay(addDays(date, 1), options.timeZone)) - 1000,
	);
	return endOfDay
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}
