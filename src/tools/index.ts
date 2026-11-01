import { addEventTool } from "./add-event";
import { deleteEventTool } from "./delete-event";
import { getEventsTool } from "./get-events";
import { listCalendarsTool } from "./list-calendars";
import { pingTool } from "./ping";
import { saveNoteTool } from "./save-note";
import { updateEventTool } from "./update-event";
import type { Tool } from "./types";

export type { ToolContext } from "./types";

/** Every tool the server exposes. Add new tools here. */
export const tools: Tool[] = [
	pingTool,
	saveNoteTool,
	addEventTool,
	updateEventTool,
	deleteEventTool,
	getEventsTool,
	listCalendarsTool,
];
