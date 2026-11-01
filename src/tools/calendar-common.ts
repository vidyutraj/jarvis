import { addDays, localParts, longDate, speakTime, startOfLocalDay, todayIn } from "../lib/dates";
import type {
	Calendar,
	CalendarEvent,
	CalendarFailure,
	GoogleCalendarClient,
} from "../lib/google-calendar";
import type { ToolContext } from "./types";

/** Steers Claude to Jarvis instead of the phone's built-in calendar. */
export const USE_JARVIS_FOR_CALENDAR =
	"This is the user's Google Calendar through Jarvis. Use Jarvis's calendar tools for every calendar request " +
	"instead of any built-in device or Apple calendar, unless the user explicitly says 'Apple calendar'.";

/** Per-request context so Claude resolves "tomorrow" and "next Thursday" correctly. */
export function dateContext({ env }: ToolContext, now: Date = new Date()): string {
	const today = todayIn(env.TIME_ZONE, now);
	return `Today is ${longDate(today)}, ${today.slice(0, 4)} (date ${today}, time zone ${env.TIME_ZONE}).`;
}

export const CALENDAR_FAILURE_REPLIES: Record<CalendarFailure, string> = {
	needs_reconnect:
		"I've lost access to your Google account. Reconnect Jarvis in Claude's settings and try again.",
	forbidden: "Google didn't allow that. You may need to reconnect Jarvis.",
	not_found: "Google couldn't find that calendar.",
	rejected: "Google didn't accept that request.",
	unreachable: "I couldn't reach Google Calendar just now. Try again in a moment.",
};

export type CalendarMatch = { ok: true; calendar: Calendar } | { ok: false; reply: string };

/**
 * Finds a calendar by spoken name: exact match first, then a single partial
 * match ("work" → "Work Calendar"). Falls back to the default calendar name.
 */
export function resolveCalendar(
	calendars: Calendar[],
	requested: string | undefined,
	defaultName: string,
	aliases: Record<string, string> = {},
): CalendarMatch {
	const spoken = requested?.trim() ? requested : defaultName;
	const aliasTarget = Object.entries(aliases).find(
		([alias]) => normalize(alias) === normalize(spoken),
	)?.[1];
	const wanted = normalize(aliasTarget ?? spoken);
	const exact = calendars.filter((calendar) => normalize(calendar.name) === wanted);
	const partial = calendars.filter((calendar) => normalize(calendar.name).includes(wanted));
	const match = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined;
	if (match) return { ok: true, calendar: match };

	const spokenName = requested?.trim() || defaultName;
	const options = joinNames(
		calendars.filter((calendar) => calendar.canWrite).map((calendar) => calendar.name),
	);
	return {
		ok: false,
		reply: options
			? `I don't see a calendar called ${spokenName}. You have ${options}.`
			: `I don't see a calendar called ${spokenName}.`,
	};
}

export interface CalendarSettings {
	aliases: Record<string, string>;
	meetCalendars: string[];
}

/** Reads the calendar settings from wrangler vars, ignoring anything malformed. */
export function calendarSettings(
	env: Pick<Env, "CALENDAR_ALIASES" | "MEET_CALENDARS">,
): CalendarSettings {
	const aliases: Record<string, string> = {};
	if (typeof env.CALENDAR_ALIASES === "object" && env.CALENDAR_ALIASES !== null) {
		for (const [alias, target] of Object.entries(env.CALENDAR_ALIASES)) {
			if (typeof target === "string") aliases[alias] = target;
		}
	}
	const meetCalendars = Array.isArray(env.MEET_CALENDARS)
		? env.MEET_CALENDARS.filter((name): name is string => typeof name === "string")
		: [];
	return { aliases, meetCalendars };
}

/** Whether a calendar is one of the given names, compared the same forgiving way. */
export function calendarNamed(calendar: Calendar, names: string[]): boolean {
	return names.some((name) => normalize(name) === normalize(calendar.name));
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Compares names the way speech-to-text mangles them: ignores case, spaces and
 * punctuation, and a trailing "calendar" ("wares port" → Waresport, "S.O.C." → SOC).
 */
function normalize(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+calendar$/, "")
		.replace(/[^\p{L}\p{N}]/gu, "");
}

/** "7 to 8 PM", "11 AM to 12:30 PM". */
export function speakTimeRange(start: string, end: string): string {
	const startText = speakTime(start);
	const endText = speakTime(end);
	const sameHalf = startText.slice(-2) === endText.slice(-2);
	return sameHalf ? `${startText.slice(0, -3)} to ${endText}` : `${startText} to ${endText}`;
}

/** When an event happens, for read-backs: "Friday, November 6, 7 to 8 PM" or "Friday, November 6, all day". */
export function speakWhen(event: Pick<CalendarEvent, "start" | "end">, timeZone: string): string {
	if (event.start.allDay) {
		const lastDay = event.end.allDay ? addDays(event.end.date, -1) : event.start.date;
		return lastDay > event.start.date
			? `${longDate(event.start.date)} to ${longDate(lastDay)}`
			: `${longDate(event.start.date)}, all day`;
	}
	const start = localParts(new Date(event.start.dateTime), timeZone);
	const end = event.end.allDay ? start : localParts(new Date(event.end.dateTime), timeZone);
	if (start.date === end.date || (end.time === "00:00" && end.date === addDays(start.date, 1))) {
		return `${longDate(start.date)}, ${speakTimeRange(start.time, end.time)}`;
	}
	return `${longDate(start.date)} at ${speakTime(start.time)} to ${longDate(end.date)} at ${speakTime(end.time)}`;
}

export interface FindEventArgs {
	/** Words from the event's title, as the user said them. */
	title: string;
	/** The day the event is on, if the user said. */
	date?: string;
	/** Its current start time, to tell apart events with the same name. */
	start_time?: string;
	/** The calendar it's on, if the user said. */
	calendar?: string;
}

export type FoundEvent =
	| { ok: true; event: CalendarEvent; calendar: Calendar; calendars: Calendar[] }
	| { ok: false; reply: string };

const SEARCH_DAYS_AHEAD = 31;
const MAX_CHOICES_SPOKEN = 4;

/**
 * Finds the one event the user means, on calendars they can edit. Searches the
 * given day, or the next month. If several different events match, the reply
 * lists them so Claude can ask which one; occurrences of the same repeating
 * event resolve to the next one.
 */
export async function findEvent(
	client: GoogleCalendarClient,
	env: Env,
	args: FindEventArgs,
	now: Date = new Date(),
): Promise<FoundEvent> {
	const timeZone = env.TIME_ZONE;
	const calendars = await client.listCalendars();
	if (!calendars.ok) return { ok: false, reply: CALENDAR_FAILURE_REPLIES[calendars.reason] };

	let toSearch = calendars.value.filter((calendar) => calendar.canWrite && calendar.selected);
	if (args.calendar) {
		const match = resolveCalendar(
			calendars.value,
			args.calendar,
			env.DEFAULT_CALENDAR,
			calendarSettings(env).aliases,
		);
		if (!match.ok) return match;
		toSearch = [match.calendar];
	}

	const firstDay = args.date ?? todayIn(timeZone, now);
	const lastDay = addDays(firstDay, args.date ? 1 : SEARCH_DAYS_AHEAD);
	const timeMin = startOfLocalDay(firstDay, timeZone);
	const timeMax = startOfLocalDay(lastDay, timeZone);
	const results = await Promise.all(
		toSearch.map((calendar) =>
			client.listEvents(calendar, timeMin, timeMax, timeZone, args.title),
		),
	);
	const failure = results.find((result) => !result.ok);
	if (failure && !failure.ok && results.every((result) => !result.ok)) {
		return { ok: false, reply: CALENDAR_FAILURE_REPLIES[failure.reason] };
	}

	const wanted = simplify(args.title);
	const matches = results
		.flatMap((result) => (result.ok ? result.value : []))
		.filter((event) => simplify(event.title).includes(wanted))
		.filter((event) => !args.start_time || startTimeOf(event, timeZone) === args.start_time)
		.sort((a, b) => startInstant(a).localeCompare(startInstant(b)));

	const where = args.date ? `on ${longDate(args.date)}` : "in the next month";
	if (matches.length === 0) {
		return { ok: false, reply: `I couldn't find an event called "${args.title}" ${where}.` };
	}

	const series = new Set(matches.map((event) => event.recurringEventId ?? event.id));
	if (series.size > 1) {
		const choices = matches
			.slice(0, MAX_CHOICES_SPOKEN)
			.map((event) => `${event.title} on ${speakWhen(event, timeZone)}`);
		const more =
			matches.length > MAX_CHOICES_SPOKEN
				? `, and ${matches.length - MAX_CHOICES_SPOKEN} more`
				: "";
		return {
			ok: false,
			reply: `I found ${matches.length} events matching "${args.title}": ${choices.join("; ")}${more}. Which one?`,
		};
	}

	const event = matches[0]!;
	const calendar = calendars.value.find((candidate) => candidate.id === event.calendarId)!;
	return { ok: true, event, calendar, calendars: calendars.value };
}

function simplify(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function startTimeOf(event: CalendarEvent, timeZone: string): string | undefined {
	return event.start.allDay
		? undefined
		: localParts(new Date(event.start.dateTime), timeZone).time;
}

/** Sortable start: all-day events sort before timed events on the same day. */
function startInstant(event: CalendarEvent): string {
	return event.start.allDay
		? `${event.start.date}T00:00:00.000Z-`
		: new Date(event.start.dateTime).toISOString();
}
