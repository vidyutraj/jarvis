import { z } from "zod";
import { GoogleCalendarClient } from "../lib/google-calendar";
import { speak, speakError } from "../lib/respond";
import {
	CALENDAR_FAILURE_REPLIES,
	USE_JARVIS_FOR_CALENDAR,
	joinNames,
	resolveCalendar,
} from "./calendar-common";
import { defineTool } from "./types";

export const listCalendarsTool = defineTool({
	name: "jarvis_list_calendars",
	description:
		`List the user's Google Calendar calendars by name, e.g. when they ask which calendars they have. ` +
		USE_JARVIS_FOR_CALENDAR,
	inputSchema: z.object({}),
	annotations: { readOnlyHint: true, openWorldHint: true },
	handler: async (_args, context) => {
		const { env } = context;
		const result = await new GoogleCalendarClient(context.auth, env).listCalendars();
		if (!result.ok) return speakError(CALENDAR_FAILURE_REPLIES[result.reason]);
		if (result.value.length === 0)
			return speak("I don't see any calendars on your Google account.");

		const defaultMatch = resolveCalendar(result.value, undefined, env.DEFAULT_CALENDAR);
		const defaultId = defaultMatch.ok ? defaultMatch.calendar.id : undefined;
		const names = result.value.map((calendar) =>
			calendar.id === defaultId ? `${calendar.name} (your default)` : calendar.name,
		);
		const count = names.length === 1 ? "1 calendar" : `${names.length} calendars`;
		return speak(`You have ${count}: ${joinNames(names)}.`);
	},
});
