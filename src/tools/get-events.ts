import { z } from "zod";
import {
	addDays,
	isValidDate,
	localParts,
	longDate,
	speakDay,
	speakTime,
	startOfLocalDay,
	todayIn,
} from "../lib/dates";
import { GoogleCalendarClient, type CalendarEvent } from "../lib/google-calendar";
import { speak, speakError } from "../lib/respond";
import {
	CALENDAR_FAILURE_REPLIES,
	USE_JARVIS_FOR_CALENDAR,
	calendarSettings,
	dateContext,
	resolveCalendar,
} from "./calendar-common";
import { defineTool } from "./types";

const MAX_EVENTS_SPOKEN = 15;

export const getEventsTool = defineTool({
	name: "jarvis_get_events",
	description: (context) =>
		`Look up what's on the user's Google Calendar for a day or a few days, e.g. "what's on my calendar ` +
		`tomorrow?" or "am I free Friday?". ${USE_JARVIS_FOR_CALENDAR} ${dateContext(context)} Convert ` +
		`relative days to an exact date. Reads all the calendars shown in the user's Google Calendar unless ` +
		`they name one. Returns a compact list; summarise it naturally and briefly when speaking.`,
	inputSchema: z.object({
		date: z
			.string()
			.refine(isValidDate, "Use a real date as YYYY-MM-DD.")
			.optional()
			.describe("First day to check, YYYY-MM-DD. Defaults to today."),
		days: z
			.number()
			.int()
			.min(1)
			.max(7)
			.optional()
			.describe("How many days to include, 1 to 7. Defaults to 1."),
		calendar: z
			.string()
			.trim()
			.max(100)
			.optional()
			.describe("Only this calendar, if the user named one."),
	}),
	annotations: { readOnlyHint: true, openWorldHint: true },
	handler: async (args, context) => {
		const { env } = context;
		const timeZone = env.TIME_ZONE;
		const today = todayIn(timeZone);
		const firstDay = args.date ?? today;
		const days = args.days ?? 1;

		const client = new GoogleCalendarClient(context.auth, env);
		const calendars = await client.listCalendars();
		if (!calendars.ok) return speakError(CALENDAR_FAILURE_REPLIES[calendars.reason]);

		let toRead = calendars.value.filter((calendar) => calendar.selected);
		if (args.calendar) {
			const match = resolveCalendar(
				calendars.value,
				args.calendar,
				env.DEFAULT_CALENDAR,
				calendarSettings(env).aliases,
			);
			if (!match.ok) return speakError(match.reply);
			toRead = [match.calendar];
		}

		const timeMin = startOfLocalDay(firstDay, timeZone);
		const timeMax = startOfLocalDay(addDays(firstDay, days), timeZone);
		const results = await Promise.all(
			toRead.map((calendar) => client.listEvents(calendar, timeMin, timeMax, timeZone)),
		);
		const failures = results.filter((result) => !result.ok);
		if (toRead.length > 0 && failures.length === toRead.length) {
			const first = failures[0]!;
			return speakError(CALENDAR_FAILURE_REPLIES[first.ok ? "unreachable" : first.reason]);
		}

		const events = results.flatMap((result) => (result.ok ? result.value : []));
		const range =
			days === 1
				? speakDay(firstDay, today)
				: `${speakDay(firstDay, today)} through ${longDate(addDays(firstDay, days - 1))}`;
		const missing =
			failures.length > 0
				? ` I couldn't read ${failures.length === 1 ? "one calendar" : `${failures.length} calendars`}.`
				: "";
		return speak(describeEvents(events, range, days, timeZone) + missing);
	},
});

interface SpokenEvent {
	day: string;
	sortKey: string;
	text: string;
}

function describeEvents(
	events: CalendarEvent[],
	range: string,
	days: number,
	timeZone: string,
): string {
	if (events.length === 0) return `Nothing on your calendar ${range}.`;

	const spoken = events
		.map((event) => toSpoken(event, timeZone))
		.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
	const shown = spoken.slice(0, MAX_EVENTS_SPOKEN);
	const more = spoken.length - shown.length;

	const lines =
		days === 1
			? shown.map((event) => event.text).join("; ")
			: groupByDay(shown)
					.map(([day, items]) => `${longDate(day)}: ${items.join("; ")}`)
					.join(". ");
	const count = events.length === 1 ? "1 event" : `${events.length} events`;
	const label = range.charAt(0).toUpperCase() + range.slice(1);
	return `${label} you have ${count}: ${lines}${more > 0 ? `; and ${more} more` : ""}.`;
}

function toSpoken(event: CalendarEvent, timeZone: string): SpokenEvent {
	if (event.start.allDay) {
		return {
			day: event.start.date,
			sortKey: `${event.start.date} 00`,
			text: `all day, ${event.title}`,
		};
	}
	const { date, time } = localParts(new Date(event.start.dateTime), timeZone);
	return { day: date, sortKey: `${date} 01 ${time}`, text: `${speakTime(time)}, ${event.title}` };
}

function groupByDay(events: SpokenEvent[]): [string, string[]][] {
	const groups = new Map<string, string[]>();
	for (const event of events) {
		groups.set(event.day, [...(groups.get(event.day) ?? []), event.text]);
	}
	return [...groups];
}
