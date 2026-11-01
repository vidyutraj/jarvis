import { z } from "zod";
import { isValidDate, isValidTime } from "../lib/dates";
import { GoogleCalendarClient } from "../lib/google-calendar";
import {
	buildRrule,
	firstOccurrence,
	repeatSchema,
	speakRepeat,
	validateRepeat,
} from "../lib/recurrence";
import { speak, speakError } from "../lib/respond";
import {
	CALENDAR_FAILURE_REPLIES,
	USE_JARVIS_FOR_CALENDAR,
	calendarNamed,
	calendarSettings,
	dateContext,
	resolveCalendar,
} from "./calendar-common";
import { buildTiming } from "./event-timing";
import { defineTool } from "./types";

export const addEventTool = defineTool({
	name: "jarvis_add_event",
	description: (context) => {
		const meetCalendars = calendarSettings(context.env).meetCalendars;
		return (
			`Add an event to the user's Google Calendar. ${USE_JARVIS_FOR_CALENDAR} ` +
			`${dateContext(context)} Convert relative dates and times ("next Thursday at 7") to an exact ` +
			`date and 24-hour time in that time zone. If the user gives no time, ask whether it's all-day ` +
			`or at what time before calling. Omit start_time only for all-day events. Default calendar: ` +
			`${context.env.DEFAULT_CALENDAR}; pass calendar only if the user names one; if a name might be ` +
			`misheard, call jarvis_list_calendars to check the exact names. Use a short, clear title in the ` +
			`user's words. For repeating events ("every Monday", "daily until finals"), fill repeat. ` +
			(meetCalendars.length
				? `Timed events on ${meetCalendars.join(", ")} get a Google Meet link automatically; `
				: "") +
			`set add_meet_link to true when the user asks for a Meet or video call, or false if they ` +
			`say not to add one. For timed reminders ("remind me to…"), use Reminders, not this tool.`
		);
	},
	inputSchema: z.object({
		title: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.describe("Short event title, e.g. 'Dinner with Sam'."),
		date: z
			.string()
			.refine(isValidDate, "Use a real date as YYYY-MM-DD.")
			.describe("Start date, YYYY-MM-DD, in the user's time zone."),
		start_time: z
			.string()
			.refine(isValidTime, "Use 24-hour HH:MM.")
			.optional()
			.describe("24-hour HH:MM, e.g. '19:00'. Omit for an all-day event."),
		end_time: z
			.string()
			.refine(isValidTime, "Use 24-hour HH:MM.")
			.optional()
			.describe(
				"24-hour HH:MM. If earlier than start_time, it ends the next day. Omit to use duration.",
			),
		duration_minutes: z
			.number()
			.int()
			.min(5)
			.max(24 * 60)
			.optional()
			.describe("Length in minutes if no end_time is given. Defaults to 60."),
		calendar: z
			.string()
			.trim()
			.max(100)
			.optional()
			.describe("Calendar name the user mentioned, e.g. 'Work'. Omit to use the default."),
		location: z.string().trim().max(300).optional().describe("Where, if the user said."),
		notes: z
			.string()
			.trim()
			.max(2000)
			.optional()
			.describe("Extra details, if the user gave any."),
		add_meet_link: z
			.boolean()
			.optional()
			.describe(
				"true to add a Google Meet link, false to skip one. Omit to use the calendar's default.",
			),
		repeat: repeatSchema.optional(),
	}),
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	handler: async (args, context) => {
		const { env } = context;
		if (!args.start_time && (args.end_time || args.duration_minutes)) {
			return speakError("I need a start time to set an end time or length.");
		}
		const repeatProblem = args.repeat ? validateRepeat(args.repeat, args.date) : null;
		if (repeatProblem) return speakError(repeatProblem);

		const client = new GoogleCalendarClient(context.auth, env);
		const calendars = await client.listCalendars();
		if (!calendars.ok) return speakError(CALENDAR_FAILURE_REPLIES[calendars.reason]);

		const settings = calendarSettings(env);
		const match = resolveCalendar(
			calendars.value,
			args.calendar,
			env.DEFAULT_CALENDAR,
			settings.aliases,
		);
		if (!match.ok) return speakError(match.reply);
		const { calendar } = match;
		if (!calendar.canWrite) {
			return speakError(`I can't add events to ${calendar.name}; it's read-only.`);
		}

		// A weekly repeat on chosen days starts on the first of those days.
		const date = args.repeat ? firstOccurrence(args.date, args.repeat) : args.date;
		const timing = buildTiming({ ...args, date }, env.TIME_ZONE);
		// By default, Meet links go on timed events in the Meet calendars only.
		const addMeet =
			args.add_meet_link ??
			(!timing.allDay && calendarNamed(calendar, settings.meetCalendars));
		const created = await client.insertEvent(calendar.id, {
			title: args.title,
			...timing.event,
			location: args.location,
			notes: args.notes,
			addMeet,
			recurrence: args.repeat
				? [buildRrule(args.repeat, { allDay: timing.allDay, timeZone: env.TIME_ZONE })]
				: undefined,
		});
		if (!created.ok) return speakError(CALENDAR_FAILURE_REPLIES[created.reason]);

		const when = args.repeat
			? `starting ${timing.when}, repeating ${speakRepeat(args.repeat, date)}`
			: `on ${timing.when}`;
		const added = `Added "${args.title}" to ${calendar.name} ${when}`;
		if (!addMeet) return speak(`${added}.`);
		return speak(
			created.value.meetLink
				? `${added}, with a Google Meet link.`
				: `${added}. Google is still setting up the Meet link.`,
		);
	},
});
