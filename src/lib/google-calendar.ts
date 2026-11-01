import type { AuthProps } from "../auth/props";
import { getGoogleAccessToken } from "./google-auth";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_EVENTS_PER_CALENDAR = 50;

export interface Calendar {
	id: string;
	/** The name the user sees (their own rename if they set one). */
	name: string;
	primary: boolean;
	/** Shown in Google Calendar's sidebar; used as the "my calendars" set for reading. */
	selected: boolean;
	canWrite: boolean;
}

export type EventTime = { allDay: true; date: string } | { allDay: false; dateTime: string };

export interface CalendarEvent {
	id: string;
	calendarId: string;
	calendarName: string;
	title: string;
	start: EventTime;
	end: EventTime;
	location?: string;
	/** Set on occurrences of a repeating event: the ID of the whole series. */
	recurringEventId?: string;
	/** Present on the series itself: its RRULE lines. */
	recurrence?: string[];
	hasMeet: boolean;
}

type GoogleTime = { date: string } | { dateTime: string; timeZone: string };

/** A partial update; only the fields given are changed. */
export interface EventPatch {
	title?: string;
	start?: GoogleTime;
	end?: GoogleTime;
	location?: string;
	notes?: string;
	addMeet?: boolean;
	/** Remove the event's Google Meet link. */
	removeMeet?: boolean;
	/** Replace the repeat rules; [] turns a series into a single event. */
	recurrence?: string[];
}

export interface NewEvent {
	title: string;
	start: GoogleTime;
	end: GoogleTime;
	location?: string;
	notes?: string;
	/** Ask Google to create a Google Meet link for the event. */
	addMeet?: boolean;
	/** RRULE lines for a repeating event, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
	recurrence?: string[];
}

export type CalendarFailure =
	| "needs_reconnect"
	| "forbidden"
	| "not_found"
	| "rejected"
	| "unreachable";
export type CalendarResult<T> = { ok: true; value: T } | { ok: false; reason: CalendarFailure };

type GoogleEnv = Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">;

/**
 * Talks to the Google Calendar API as the signed-in user. Every call gets a
 * valid token first and, on a 401, refreshes once and retries once.
 */
export class GoogleCalendarClient {
	constructor(
		private readonly auth: AuthProps,
		private readonly env: GoogleEnv,
	) {}

	async listCalendars(): Promise<CalendarResult<Calendar[]>> {
		const result = await this.request("/users/me/calendarList?maxResults=250");
		if (!result.ok) return result;
		const items = asArray(result.value.items);
		return {
			ok: true,
			value: items.flatMap((item): Calendar[] => {
				if (typeof item.id !== "string") return [];
				const name = str(item.summaryOverride) ?? str(item.summary) ?? item.id;
				return [
					{
						id: item.id,
						name,
						primary: item.primary === true,
						selected: item.selected === true || item.primary === true,
						canWrite: item.accessRole === "owner" || item.accessRole === "writer",
					},
				];
			}),
		};
	}

	async insertEvent(
		calendarId: string,
		event: NewEvent,
	): Promise<CalendarResult<{ id: string; meetLink?: string }>> {
		// conferenceDataVersion=1 is required for Google to honour a Meet createRequest.
		const query = event.addMeet ? "?conferenceDataVersion=1" : "";
		const result = await this.request(
			`/calendars/${encodeURIComponent(calendarId)}/events${query}`,
			{
				method: "POST",
				body: JSON.stringify({
					summary: event.title,
					start: event.start,
					end: event.end,
					...(event.location ? { location: event.location } : {}),
					...(event.notes ? { description: event.notes } : {}),
					...(event.recurrence ? { recurrence: event.recurrence } : {}),
					...(event.addMeet ? meetRequest() : {}),
				}),
			},
		);
		if (!result.ok) return result;
		return {
			ok: true,
			value: { id: str(result.value.id) ?? "", meetLink: str(result.value.hangoutLink) },
		};
	}

	/** Events overlapping [timeMin, timeMax) on one calendar, recurring events expanded. */
	async listEvents(
		calendar: Calendar,
		timeMin: string,
		timeMax: string,
		timeZone: string,
		search?: string,
	): Promise<CalendarResult<CalendarEvent[]>> {
		const query = new URLSearchParams({
			timeMin,
			timeMax,
			timeZone,
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: String(MAX_EVENTS_PER_CALENDAR),
			...(search ? { q: search } : {}),
		});
		const result = await this.request(`${eventsPath(calendar.id)}?${query}`);
		if (!result.ok) return result;
		return {
			ok: true,
			value: asArray(result.value.items).flatMap((item) => {
				const event = parseEvent(item, calendar);
				return event ? [event] : [];
			}),
		};
	}

	async getEvent(calendar: Calendar, eventId: string): Promise<CalendarResult<CalendarEvent>> {
		const result = await this.request(
			`${eventsPath(calendar.id)}/${encodeURIComponent(eventId)}`,
		);
		if (!result.ok) return result;
		const event = parseEvent(result.value, calendar);
		return event ? { ok: true, value: event } : { ok: false, reason: "not_found" };
	}

	async patchEvent(
		calendar: Calendar,
		eventId: string,
		patch: EventPatch,
	): Promise<CalendarResult<CalendarEvent>> {
		// conferenceDataVersion=1 is required for Google to apply any Meet change.
		const query = patch.addMeet || patch.removeMeet ? "?conferenceDataVersion=1" : "";
		const result = await this.request(
			`${eventsPath(calendar.id)}/${encodeURIComponent(eventId)}${query}`,
			{
				method: "PATCH",
				body: JSON.stringify({
					...(patch.title !== undefined ? { summary: patch.title } : {}),
					...(patch.start ? { start: patch.start } : {}),
					...(patch.end ? { end: patch.end } : {}),
					...(patch.location !== undefined ? { location: patch.location } : {}),
					...(patch.notes !== undefined ? { description: patch.notes } : {}),
					...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
					...(patch.addMeet ? meetRequest() : {}),
					...(patch.removeMeet ? { conferenceData: null } : {}),
				}),
			},
		);
		if (!result.ok) return result;
		const event = parseEvent(result.value, calendar);
		return event ? { ok: true, value: event } : { ok: false, reason: "rejected" };
	}

	/** Moves an event (or a whole series) to another calendar. */
	async moveEvent(
		from: Calendar,
		eventId: string,
		to: Calendar,
	): Promise<CalendarResult<CalendarEvent>> {
		const query = new URLSearchParams({ destination: to.id });
		const result = await this.request(
			`${eventsPath(from.id)}/${encodeURIComponent(eventId)}/move?${query}`,
			{ method: "POST" },
		);
		if (!result.ok) return result;
		const event = parseEvent(result.value, to);
		return event ? { ok: true, value: event } : { ok: false, reason: "rejected" };
	}

	async deleteEvent(calendar: Calendar, eventId: string): Promise<CalendarResult<true>> {
		const result = await this.request(
			`${eventsPath(calendar.id)}/${encodeURIComponent(eventId)}`,
			{ method: "DELETE" },
		);
		return result.ok ? { ok: true, value: true } : result;
	}

	private async request(
		path: string,
		init: RequestInit = {},
	): Promise<CalendarResult<Record<string, unknown>>> {
		const first = await this.requestOnce(path, init, false);
		if (first.ok || first.reason !== "unauthorized") return toResult(first);
		// A 401 means the token is dead: refresh once and retry once. Never loop.
		return toResult(await this.requestOnce(path, init, true));
	}

	private async requestOnce(
		path: string,
		init: RequestInit,
		forceRefresh: boolean,
	): Promise<RawResult> {
		const token = await getGoogleAccessToken(
			this.auth,
			this.env,
			forceRefresh ? Infinity : Date.now(),
		);
		if (!token.ok) return { ok: false, reason: token.reason };

		let response: Response;
		try {
			response = await fetch(`${CALENDAR_API}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${token.accessToken}`,
					...(init.body ? { "Content-Type": "application/json" } : {}),
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			console.error(
				`Google Calendar request failed (${error instanceof Error ? error.name : "UnknownError"}).`,
			);
			return { ok: false, reason: "unreachable" };
		}

		const body = await readJson(response);
		if (response.ok) return { ok: true, value: body ?? {} };

		// Log the status and Google's message only; never the URL's query or the token.
		const message =
			str((body?.error as Record<string, unknown> | undefined)?.message) ?? "no message";
		console.error(
			`Google Calendar ${init.method ?? "GET"} failed (HTTP ${response.status}): ${message}`,
		);
		if (response.status === 401) return { ok: false, reason: "unauthorized" };
		if (response.status === 403) return { ok: false, reason: "forbidden" };
		// 410 Gone: already deleted.
		if (response.status === 404 || response.status === 410) {
			return { ok: false, reason: "not_found" };
		}
		if (response.status >= 500 || response.status === 429)
			return { ok: false, reason: "unreachable" };
		return { ok: false, reason: "rejected" };
	}
}

type RawResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; reason: CalendarFailure | "unauthorized" };

/** A 401 that survives a fresh token means access is gone: the user must reconnect. */
function toResult(result: RawResult): CalendarResult<Record<string, unknown>> {
	if (result.ok || result.reason !== "unauthorized")
		return result as CalendarResult<Record<string, unknown>>;
	return { ok: false, reason: "needs_reconnect" };
}

function eventsPath(calendarId: string): string {
	return `/calendars/${encodeURIComponent(calendarId)}/events`;
}

/** Asks Google to create a Meet link. The random requestId makes retries safe (no second Meet). */
function meetRequest() {
	return {
		conferenceData: {
			createRequest: {
				requestId: crypto.randomUUID(),
				conferenceSolutionKey: { type: "hangoutsMeet" },
			},
		},
	};
}

function parseEvent(item: Record<string, unknown>, calendar: Calendar): CalendarEvent | null {
	if (item.status === "cancelled" || typeof item.id !== "string") return null;
	const start = eventTime(item.start);
	const end = eventTime(item.end);
	if (!start || !end) return null;
	const recurrence = Array.isArray(item.recurrence)
		? item.recurrence.filter((line): line is string => typeof line === "string")
		: undefined;
	return {
		id: item.id,
		calendarId: calendar.id,
		calendarName: calendar.name,
		title: str(item.summary) ?? "Untitled event",
		start,
		end,
		location: str(item.location),
		recurringEventId: str(item.recurringEventId),
		recurrence,
		hasMeet: typeof item.hangoutLink === "string",
	};
}

function eventTime(value: unknown): EventTime | null {
	if (typeof value !== "object" || value === null) return null;
	const time = value as Record<string, unknown>;
	if (typeof time.dateTime === "string") return { allDay: false, dateTime: time.dateTime };
	if (typeof time.date === "string") return { allDay: true, date: time.date };
	return null;
}

function asArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((item) => typeof item === "object" && item !== null)
		: [];
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}
