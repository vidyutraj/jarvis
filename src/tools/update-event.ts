import { z } from "zod";
import { addDays, isValidDate, isValidTime, localParts, todayIn } from "../lib/dates";
import {
	buildRrule,
	endRecurrence,
	firstOccurrence,
	repeatSchema,
	speakRepeat,
	validateRepeat,
	type RepeatRule,
} from "../lib/recurrence";
import { GoogleCalendarClient, type CalendarEvent, type EventPatch } from "../lib/google-calendar";
import { speak, speakError } from "../lib/respond";
import {
	CALENDAR_FAILURE_REPLIES,
	USE_JARVIS_FOR_CALENDAR,
	calendarSettings,
	dateContext,
	findEvent,
	resolveCalendar,
	speakTimeRange,
	speakWhen,
} from "./calendar-common";
import { buildTiming } from "./event-timing";
import { defineTool } from "./types";

const dateField = z.string().refine(isValidDate, "Use a real date as YYYY-MM-DD.");
const timeField = z.string().refine(isValidTime, "Use 24-hour HH:MM.");

export const findEventFields = {
	title: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe("Words from the event's current title, e.g. 'dinner with Sam'."),
	date: dateField.optional().describe("The day the event is on now, YYYY-MM-DD, if known."),
	start_time: timeField
		.optional()
		.describe("Its current start time (24-hour HH:MM), only to tell apart same-named events."),
	calendar: z
		.string()
		.trim()
		.max(100)
		.optional()
		.describe("The calendar it's on now, if the user said."),
	scope: z
		.enum(["this", "all"])
		.optional()
		.describe(
			"For repeating events: 'this' (default) for one occurrence, 'all' for the whole series.",
		),
};

export const updateEventTool = defineTool({
	name: "jarvis_update_event",
	description: (context) =>
		`Change an existing event on the user's Google Calendar: move it to another time or day, rename ` +
		`it, change its location or notes, add or remove a Google Meet link, move it to another ` +
		`calendar, make it repeat, change how it repeats, or stop it repeating. ` +
		`${USE_JARVIS_FOR_CALENDAR} ${dateContext(context)} Identify the event by its title, plus its ` +
		`current date if the user said. Only fill the fields the user wants changed; when only the ` +
		`time changes, the event keeps its length. For a repeating event, change just that occurrence ` +
		`unless the user says all of them or every one; repeat and stop_repeating always apply to the ` +
		`whole series. If several events match, ask the user which one and call again with its date ` +
		`or start_time.`,
	inputSchema: z.object({
		...findEventFields,
		new_title: z.string().trim().min(1).max(200).optional().describe("New title."),
		new_date: dateField.optional().describe("New day, YYYY-MM-DD."),
		new_start_time: timeField.optional().describe("New start time, 24-hour HH:MM."),
		new_end_time: timeField.optional().describe("New end time, 24-hour HH:MM."),
		new_duration_minutes: z
			.number()
			.int()
			.min(5)
			.max(24 * 60)
			.optional()
			.describe("New length in minutes (instead of new_end_time)."),
		all_day: z
			.boolean()
			.optional()
			.describe("true to make it all-day; false (with new_start_time) to give it a time."),
		move_to_calendar: z
			.string()
			.trim()
			.max(100)
			.optional()
			.describe("Name of another calendar to move it to."),
		location: z.string().trim().max(300).optional().describe("New location ('' to clear)."),
		notes: z.string().trim().max(2000).optional().describe("New notes ('' to clear)."),
		add_meet_link: z
			.boolean()
			.optional()
			.describe("true to add a Google Meet link, false to remove it."),
		repeat: repeatSchema
			.optional()
			.describe(
				"Make the event repeat, or replace how it repeats. Applies to the whole series.",
			),
		stop_repeating: z
			.boolean()
			.optional()
			.describe(
				"true to stop a repeating event: no occurrences after today (past ones are kept).",
			),
	}),
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	handler: async (args, context) => {
		const { env } = context;
		const timeZone = env.TIME_ZONE;
		const changesTime =
			args.new_date !== undefined ||
			args.new_start_time !== undefined ||
			args.new_end_time !== undefined ||
			args.new_duration_minutes !== undefined ||
			args.all_day !== undefined;
		const changesSomething =
			changesTime ||
			args.new_title !== undefined ||
			args.move_to_calendar !== undefined ||
			args.location !== undefined ||
			args.notes !== undefined ||
			args.add_meet_link !== undefined ||
			args.repeat !== undefined ||
			args.stop_repeating === true;
		if (!changesSomething) return speakError("What should I change about that event?");
		if (args.new_end_time && args.new_duration_minutes) {
			return speakError("Give either a new end time or a new length, not both.");
		}
		if (args.repeat && args.stop_repeating) {
			return speakError("Should it keep repeating with a new pattern, or stop repeating?");
		}

		const client = new GoogleCalendarClient(context.auth, env);
		const found = await findEvent(client, env, args);
		if (!found.ok) return speakError(found.reply);
		let { calendar } = found;

		// "All of them", and any repeat change, edit the series itself, not one occurrence.
		const seriesLevel =
			args.scope === "all" || args.repeat !== undefined || args.stop_repeating === true;
		let target: CalendarEvent = found.event;
		if (seriesLevel && found.event.recurringEventId) {
			const series = await client.getEvent(calendar, found.event.recurringEventId);
			if (!series.ok) return speakError(CALENDAR_FAILURE_REPLIES[series.reason]);
			target = series.value;
		}
		const isSeries = Boolean(target.recurrence?.length);
		const isOccurrence = Boolean(target.recurringEventId) && !isSeries;

		if (isSeries && args.new_date) {
			return speakError(
				"I can change the time of every occurrence, but not move the whole series to another day. I can delete it and add it again instead.",
			);
		}
		if (args.stop_repeating && !isSeries) {
			return speakError(`"${target.title}" doesn't repeat.`);
		}

		let moved = false;
		if (args.move_to_calendar) {
			const destination = resolveCalendar(
				found.calendars,
				args.move_to_calendar,
				env.DEFAULT_CALENDAR,
				calendarSettings(env).aliases,
			);
			if (!destination.ok) return speakError(destination.reply);
			if (destination.calendar.id !== calendar.id) {
				if (!destination.calendar.canWrite) {
					return speakError(
						`I can't add events to ${destination.calendar.name}; it's read-only.`,
					);
				}
				if (isOccurrence) {
					return speakError(
						"Google only moves a whole repeating event to another calendar. Should I move all of them?",
					);
				}
				const result = await client.moveEvent(calendar, target.id, destination.calendar);
				if (!result.ok) return speakError(CALENDAR_FAILURE_REPLIES[result.reason]);
				target = result.value;
				calendar = destination.calendar;
				moved = true;
			}
		}

		const patch: EventPatch = {};
		if (args.new_title !== undefined) patch.title = args.new_title;
		if (args.location !== undefined) patch.location = args.location;
		if (args.notes !== undefined) patch.notes = args.notes;
		const addMeet = args.add_meet_link === true && !target.hasMeet;
		const removeMeet = args.add_meet_link === false && target.hasMeet;
		if (addMeet) patch.addMeet = true;
		if (removeMeet) patch.removeMeet = true;

		if (changesTime) {
			const timing = newTiming(target, args, timeZone);
			if (!timing.ok) return speakError(timing.reply);
			patch.start = timing.start;
			patch.end = timing.end;
		}

		let repeatText: string | undefined;
		if (args.repeat) {
			const change = applyRepeat(target, patch, args.repeat, timeZone);
			if (!change.ok) return speakError(change.reply);
			repeatText = change.spoken;
		}

		let stopped: "after_today" | "one_off" | undefined;
		if (args.stop_repeating) {
			const allDay = target.start.allDay;
			const seriesStart = startDateOf(target, timeZone);
			const today = todayIn(timeZone);
			if (seriesStart > today) {
				// Hasn't started yet: keep just its first date as a single event.
				patch.recurrence = [];
				stopped = "one_off";
			} else {
				patch.recurrence = endRecurrence(target.recurrence ?? [], today, {
					allDay,
					timeZone,
				});
				stopped = "after_today";
			}
		}

		if (Object.keys(patch).length === 0) {
			if (args.add_meet_link !== undefined && !moved) {
				return speak(
					args.add_meet_link
						? `"${target.title}" already has a Google Meet link.`
						: `"${target.title}" doesn't have a Google Meet link.`,
				);
			}
		}

		let updated = target;
		if (Object.keys(patch).length > 0) {
			const result = await client.patchEvent(calendar, target.id, patch);
			if (!result.ok) return speakError(CALENDAR_FAILURE_REPLIES[result.reason]);
			updated = result.value;
		}

		return speak(
			describeUpdate(updated, {
				isSeries,
				moved,
				addMeet,
				removeMeet,
				repeatText,
				stopped,
				calendarName: calendar.name,
				timeZone,
			}),
		);
	},
});

type RepeatChange = { ok: true; spoken: string } | { ok: false; reply: string };

/**
 * Sets the repeat rule on the patch. If a weekly repeat's chosen days don't
 * include the event's day, the event moves to the first chosen day so Google
 * doesn't keep an extra occurrence on the original day.
 */
function applyRepeat(
	event: CalendarEvent,
	patch: EventPatch,
	rule: RepeatRule,
	timeZone: string,
): RepeatChange {
	const allDay = patch.start ? "date" in patch.start : event.start.allDay;
	const startDate = patch.start
		? "date" in patch.start
			? patch.start.date
			: patch.start.dateTime.slice(0, 10)
		: startDateOf(event, timeZone);
	const first = firstOccurrence(startDate, rule);
	const problem = validateRepeat(rule, first);
	if (problem) return { ok: false, reply: problem };

	if (first !== startDate) {
		const shifted = patch.start
			? shiftTiming(patch, daysBetween(startDate, first))
			: newTiming(event, { new_date: first }, timeZone);
		if (!shifted.ok) return shifted;
		patch.start = shifted.start;
		patch.end = shifted.end;
	}
	patch.recurrence = [buildRrule(rule, { allDay, timeZone })];
	return { ok: true, spoken: speakRepeat(rule, first) };
}

/** Moves an already-computed start/end by whole days. */
function shiftTiming(patch: EventPatch, days: number): TimingChange {
	const shift = (time: NonNullable<EventPatch["start"]>): NonNullable<EventPatch["start"]> =>
		"date" in time
			? { date: addDays(time.date, days) }
			: {
					...time,
					dateTime: `${addDays(time.dateTime.slice(0, 10), days)}${time.dateTime.slice(10)}`,
				};
	return { ok: true, start: shift(patch.start!), end: shift(patch.end!) };
}

function startDateOf(event: CalendarEvent, timeZone: string): string {
	return event.start.allDay
		? event.start.date
		: localParts(new Date(event.start.dateTime), timeZone).date;
}

type TimingChange =
	| { ok: true; start: NonNullable<EventPatch["start"]>; end: NonNullable<EventPatch["end"]> }
	| { ok: false; reply: string };

interface TimeArgs {
	new_date?: string;
	new_start_time?: string;
	new_end_time?: string;
	new_duration_minutes?: number;
	all_day?: boolean;
}

/** Applies the requested changes to the event's current timing; unchanged parts are kept. */
function newTiming(event: CalendarEvent, args: TimeArgs, timeZone: string): TimingChange {
	const current = event.start.allDay
		? { date: event.start.date, time: undefined }
		: localParts(new Date(event.start.dateTime), timeZone);
	const date = args.new_date ?? current.date;
	const makeAllDay = args.all_day ?? (event.start.allDay && !args.new_start_time);

	if (makeAllDay) {
		// Keep a multi-day all-day event's length when moving it.
		const days =
			event.start.allDay && event.end.allDay
				? daysBetween(event.start.date, event.end.date)
				: 1;
		return { ok: true, start: { date }, end: { date: addDays(date, Math.max(1, days)) } };
	}

	const startTime = args.new_start_time ?? current.time;
	if (!startTime) return { ok: false, reply: "What time should it start?" };
	const currentMinutes =
		!event.start.allDay && !event.end.allDay
			? Math.round(
					(Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime)) / 60_000,
				)
			: undefined;
	const timing = buildTiming(
		{
			date,
			start_time: startTime,
			end_time: args.new_end_time,
			duration_minutes: args.new_end_time
				? undefined
				: (args.new_duration_minutes ?? currentMinutes),
		},
		timeZone,
	);
	return { ok: true, start: timing.event.start, end: timing.event.end };
}

function daysBetween(start: string, end: string): number {
	return Math.round(
		(Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
	);
}

function describeUpdate(
	event: CalendarEvent,
	options: {
		isSeries: boolean;
		moved: boolean;
		addMeet: boolean;
		removeMeet: boolean;
		repeatText?: string;
		stopped?: "after_today" | "one_off";
		calendarName: string;
		timeZone: string;
	},
): string {
	let when: string;
	if (options.stopped === "after_today") {
		when = "it no longer repeats after today";
	} else if (options.stopped === "one_off") {
		when = `it no longer repeats; it's just on ${speakWhen(event, options.timeZone)}`;
	} else if (options.repeatText) {
		when = `it now repeats ${options.repeatText}, starting ${speakWhen(event, options.timeZone)}`;
	} else if (options.isSeries) {
		const times =
			event.start.allDay || event.end.allDay
				? "all day"
				: speakTimeRange(
						localParts(new Date(event.start.dateTime), options.timeZone).time,
						localParts(new Date(event.end.dateTime), options.timeZone).time,
					);
		when = `every occurrence is now ${times}`;
	} else {
		when = `it's now on ${speakWhen(event, options.timeZone)}`;
	}
	const extras = [
		options.moved ? `in ${options.calendarName}` : "",
		options.addMeet ? "with a Google Meet link" : "",
		options.removeMeet ? "without a Meet link" : "",
	].filter(Boolean);
	return `Updated "${event.title}": ${when}${extras.length ? `, ${extras.join(", ")}` : ""}.`;
}
