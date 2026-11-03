import { accountsTool } from "./accounts";
import { addEventTool } from "./add-event";
import { transactionsTool } from "./transactions";
import { connectBankTool } from "./connect-bank";
import { deleteEventTool } from "./delete-event";
import { getEventsTool } from "./get-events";
import { listCalendarsTool } from "./list-calendars";
import { pingTool } from "./ping";
import { saveNoteTool } from "./save-note";
import { spendingTool } from "./spending";
import { spendingPageTool } from "./spending-page";
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
	connectBankTool,
	spendingTool,
	spendingPageTool,
	transactionsTool,
	accountsTool,
];
