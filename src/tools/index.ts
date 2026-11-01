import { pingTool } from "./ping";
import { saveNoteTool } from "./save-note";
import type { Tool } from "./types";

/** Every tool the server exposes. Add new tools here. */
export const tools: Tool[] = [pingTool, saveNoteTool];
