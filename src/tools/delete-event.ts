import { z } from "zod";
import { GoogleCalendarClient } from "../lib/google-calendar";
import { speak, speakError } from "../lib/respond";
import {
	CALENDAR_FAILURE_REPLIES,
	USE_JARVIS_FOR_CALENDAR,
	dateContext,
	findEvent,
	speakWhen,
} from "./calendar-common";
import { defineTool } from "./types";
import { findEventFields } from "./update-event";

export const deleteEventTool = defineTool({
	name: "jarvis_delete_event",
	description: (context) =>
		`Delete an event from the user's Google Calendar. ${USE_JARVIS_FOR_CALENDAR} ` +
		`${dateContext(context)} This can't be undone: before calling, say which event you'll delete ` +
		`(title, day and time) and wait for the user to confirm. For a repeating event, delete just that ` +
		`occurrence unless the user clearly says all of them. To move an event, use ` +
		`jarvis_update_event instead of deleting and re-adding it.`,
	inputSchema: z.object(findEventFields),
	annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
	handler: async (args, context) => {
		const { env } = context;
		const client = new GoogleCalendarClient(context.auth, env);
		const found = await findEvent(client, env, args);
		if (!found.ok) return speakError(found.reply);
		const { event, calendar } = found;

		const deleteSeries = args.scope === "all" && Boolean(event.recurringEventId);
		const result = await client.deleteEvent(
			calendar,
			deleteSeries ? event.recurringEventId! : event.id,
		);
		if (!result.ok) return speakError(CALENDAR_FAILURE_REPLIES[result.reason]);

		return speak(
			deleteSeries
				? `Deleted every "${event.title}" from ${calendar.name}.`
				: `Deleted "${event.title}" on ${speakWhen(event, env.TIME_ZONE)} from ${calendar.name}.`,
		);
	},
});
