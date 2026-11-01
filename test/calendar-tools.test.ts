import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEventTool } from "../src/tools/add-event";
import { deleteEventTool } from "../src/tools/delete-event";
import { updateEventTool } from "../src/tools/update-event";
import { getEventsTool } from "../src/tools/get-events";
import { calendarSettings, resolveCalendar } from "../src/tools/calendar-common";
import { listCalendarsTool } from "../src/tools/list-calendars";
import type { ToolContext } from "../src/tools";
import { expectSpeakable, jsonResponse, resultText, testAuth, testEnv } from "./helpers";

const CALENDAR_LIST = {
	items: [
		{
			id: "primary-id",
			summary: "owner@example.com",
			primary: true,
			selected: true,
			accessRole: "owner",
		},
		{ id: "daily-id", summary: "Daily Life", selected: true, accessRole: "owner" },
		{ id: "work-id", summary: "Work Calendar", selected: true, accessRole: "writer" },
		{
			id: "holidays-id",
			summary: "Holidays in United States",
			selected: true,
			accessRole: "reader",
		},
		{ id: "hidden-id", summary: "Old Project", selected: false, accessRole: "owner" },
	],
};

interface Recorded {
	method: string;
	url: URL;
	body: unknown;
}

/** A fake Google Calendar API. `routes` can override responses per path. */
function fakeCalendar(routes: Record<string, (req: Recorded) => Response> = {}) {
	const requests: Recorded[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(new Request(input).url);
		const req: Recorded = {
			method: init?.method ?? "GET",
			url,
			body: parseBody(init?.body),
		};
		requests.push(req);
		const path = url.pathname.replace("/calendar/v3", "");
		const route = routes[path] ?? routes[`${req.method} ${path}`];
		if (route) return route(req);
		if (path === "/users/me/calendarList") return jsonResponse(CALENDAR_LIST);
		if (req.method === "POST" && path.endsWith("/events"))
			return jsonResponse({ id: "new-event" });
		if (req.method === "DELETE") return new Response(null, { status: 204 });
		if (path.endsWith("/events")) return jsonResponse({ items: [] });
		throw new Error(`Unexpected request: ${req.method} ${url}`);
	});
	return requests;
}

/** JSON for Calendar API calls; the token refresh is form-encoded. */
function parseBody(body: BodyInit | null | undefined): unknown {
	if (body === undefined || body === null) return undefined;
	if (body instanceof URLSearchParams) return Object.fromEntries(body);
	return JSON.parse(String(body));
}

function context(): ToolContext {
	return { env: testEnv(), auth: testAuth() };
}

/** Event list response; gives each event an id like Google does. */
function eventsAt(...items: Record<string, unknown>[]) {
	return () =>
		jsonResponse({ items: items.map((item, index) => ({ id: `evt-${index}`, ...item })) });
}

beforeEach(() => {
	// Sunday, November 1, 2026, 11 AM in New York.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-01T16:00:00Z"));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("jarvis_add_event", () => {
	it("adds a timed event to the default calendar and reads back the exact time", async () => {
		const requests = fakeCalendar();

		const result = await addEventTool.handler(
			{ title: "Dinner with Sam", date: "2026-11-06", start_time: "19:00" },
			context(),
		);

		expect(resultText(result)).toBe(
			'Added "Dinner with Sam" to Daily Life on Friday, November 6, 7 to 8 PM.',
		);
		expectSpeakable(result);
		const insert = requests.find((r) => r.method === "POST")!;
		expect(insert.url.pathname).toBe("/calendar/v3/calendars/daily-id/events");
		expect(insert.body).toEqual({
			summary: "Dinner with Sam",
			start: { dateTime: "2026-11-06T19:00:00", timeZone: "America/New_York" },
			end: { dateTime: "2026-11-06T20:00:00", timeZone: "America/New_York" },
		});
		expect(insert.url.toString()).not.toContain("google-access-token");
	});

	it("uses a calendar the user names, matching loosely", async () => {
		const requests = fakeCalendar();

		const result = await addEventTool.handler(
			{
				title: "Standup",
				date: "2026-11-02",
				start_time: "09:30",
				duration_minutes: 15,
				calendar: "work",
			},
			context(),
		);

		expect(resultText(result)).toBe(
			'Added "Standup" to Work Calendar on Monday, November 2, 9:30 to 9:45 AM.',
		);
		expect(requests.find((r) => r.method === "POST")!.url.pathname).toContain(
			"/calendars/work-id/",
		);
	});

	it("rolls an end time past midnight into the next day", async () => {
		const requests = fakeCalendar();

		const result = await addEventTool.handler(
			{ title: "Party", date: "2026-11-07", start_time: "22:00", end_time: "01:00" },
			context(),
		);

		expect(resultText(result)).toContain("10 PM to 1 AM");
		const body = requests.find((r) => r.method === "POST")!.body as {
			end: { dateTime: string };
		};
		expect(body.end.dateTime).toBe("2026-11-08T01:00:00");
	});

	it("creates all-day events with Google's exclusive end date", async () => {
		const requests = fakeCalendar();

		const result = await addEventTool.handler(
			{ title: "Mom's birthday", date: "2026-11-12" },
			context(),
		);

		expect(resultText(result)).toBe(
			`Added "Mom's birthday" to Daily Life on Thursday, November 12, all day.`,
		);
		expect(requests.find((r) => r.method === "POST")!.body).toMatchObject({
			start: { date: "2026-11-12" },
			end: { date: "2026-11-13" },
		});
	});

	it("names the available calendars when it can't find the one asked for", async () => {
		fakeCalendar();

		const result = await addEventTool.handler(
			{ title: "Lift", date: "2026-11-03", start_time: "07:00", calendar: "Gym" },
			context(),
		);

		expect(result.isError).toBe(true);
		expect(resultText(result)).toBe(
			"I don't see a calendar called Gym. You have owner@example.com, Daily Life, Work Calendar and Old Project.",
		);
	});

	it("refuses read-only calendars", async () => {
		const requests = fakeCalendar();

		const result = await addEventTool.handler(
			{ title: "Day off", date: "2026-11-26", calendar: "holidays" },
			context(),
		);

		expect(resultText(result)).toBe(
			"I can't add events to Holidays in United States; it's read-only.",
		);
		expect(requests.some((r) => r.method === "POST")).toBe(false);
	});

	it("needs a start time before an end time or length", async () => {
		const result = await addEventTool.handler(
			{ title: "Thing", date: "2026-11-03", end_time: "10:00" },
			context(),
		);
		expect(result.isError).toBe(true);
	});

	it("refreshes once and retries when Google rejects the token", async () => {
		let calls = 0;
		const requests = fakeCalendar({
			"/users/me/calendarList": () =>
				calls++ === 0 ? jsonResponse({}, 401) : jsonResponse(CALENDAR_LIST),
			"/token": () => jsonResponse({ access_token: "fresh-token", expires_in: 3599 }),
		});

		const result = await addEventTool.handler(
			{ title: "Dinner", date: "2026-11-06", start_time: "19:00" },
			context(),
		);

		expect(result.isError).toBeUndefined();
		const listCalls = requests
			.filter((r) => r.url.pathname.endsWith("/calendarList"))
			.map((r) => r.url.pathname);
		expect(listCalls).toHaveLength(2); // one failed call, one retry, no loop
		expect(requests.filter((r) => r.url.pathname === "/token")).toHaveLength(1);
	});

	it("asks to reconnect when Google keeps rejecting the token", async () => {
		const requests = fakeCalendar({
			"/users/me/calendarList": () => jsonResponse({}, 401),
			"/token": () => jsonResponse({ access_token: "still-bad", expires_in: 3599 }),
		});

		const result = await addEventTool.handler(
			{ title: "Dinner", date: "2026-11-06", start_time: "19:00" },
			context(),
		);

		expect(resultText(result)).toBe(
			"I've lost access to your Google account. Reconnect Jarvis in Claude's settings and try again.",
		);
		expectSpeakable(result);
		expect(requests.filter((r) => r.url.pathname.endsWith("/calendarList"))).toHaveLength(2);
	});

	it("says Google is unreachable on a network failure", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

		const result = await addEventTool.handler(
			{ title: "Dinner", date: "2026-11-06", start_time: "19:00" },
			context(),
		);

		expect(resultText(result)).toBe(
			"I couldn't reach Google Calendar just now. Try again in a moment.",
		);
	});

	it("tells Claude today's date, the default calendar, and to prefer Jarvis", () => {
		const description = addEventTool.description;
		const text = typeof description === "function" ? description(context()) : description;
		expect(text).toContain("Today is Sunday, November 1, 2026");
		expect(text).toContain("Default calendar: Daily Life");
		expect(text).toContain("instead of any built-in device or Apple calendar");
	});
});

describe("Google Meet links for Waresport", () => {
	const listWithWaresport = () =>
		jsonResponse({
			items: [
				...CALENDAR_LIST.items,
				{ id: "waresport-id", summary: "Waresport", selected: true, accessRole: "owner" },
			],
		});

	it("adds a Meet link to timed Waresport events and says so", async () => {
		const requests = fakeCalendar({
			"/users/me/calendarList": listWithWaresport,
			"POST /calendars/waresport-id/events": () =>
				jsonResponse({ id: "evt", hangoutLink: "https://meet.google.com/abc-defg-hij" }),
		});

		const result = await addEventTool.handler(
			{ title: "Team sync", date: "2026-11-02", start_time: "15:00", calendar: "wares port" },
			context(),
		);

		expect(resultText(result)).toBe(
			'Added "Team sync" to Waresport on Monday, November 2, 3 to 4 PM, with a Google Meet link.',
		);
		expect(resultText(result)).not.toContain("meet.google.com"); // never read a URL aloud
		const insert = requests.find((r) => r.method === "POST")!;
		expect(insert.url.searchParams.get("conferenceDataVersion")).toBe("1");
		expect(insert.body).toMatchObject({
			conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } },
		});
		const requestId = (
			insert.body as { conferenceData: { createRequest: { requestId: string } } }
		).conferenceData.createRequest.requestId;
		expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("says the Meet link is still being set up if Google hasn't finished", async () => {
		fakeCalendar({ "/users/me/calendarList": listWithWaresport });

		const result = await addEventTool.handler(
			{ title: "Team sync", date: "2026-11-02", start_time: "15:00", calendar: "Waresport" },
			context(),
		);

		expect(resultText(result)).toContain("Google is still setting up the Meet link.");
		expectSpeakable(result);
	});

	it("doesn't add Meet links to all-day Waresport events", async () => {
		const requests = fakeCalendar({ "/users/me/calendarList": listWithWaresport });

		await addEventTool.handler(
			{ title: "Launch day", date: "2026-11-20", calendar: "Waresport" },
			context(),
		);

		const insert = requests.find((r) => r.method === "POST")!;
		expect(insert.url.searchParams.has("conferenceDataVersion")).toBe(false);
		expect(insert.body).not.toHaveProperty("conferenceData");
	});

	it("doesn't add Meet links to other calendars", async () => {
		const requests = fakeCalendar();

		const result = await addEventTool.handler(
			{ title: "Dinner", date: "2026-11-06", start_time: "19:00" },
			context(),
		);

		expect(resultText(result)).not.toContain("Meet");
		expect(requests.find((r) => r.method === "POST")!.body).not.toHaveProperty(
			"conferenceData",
		);
	});
});

describe("calendar nicknames", () => {
	const calendars = ["SOC", "Daily Life"].map((name) => ({
		id: `${name}-id`,
		name,
		primary: false,
		selected: true,
		canWrite: true,
	}));

	it("reads the nicknames and Meet calendars from settings", () => {
		expect(calendarSettings(testEnv())).toEqual({
			aliases: { sock: "SOC" },
			meetCalendars: ["Waresport"],
		});
	});

	it.each(["sock", "Sock", "sock calendar"])("sends %j to SOC", (spoken) => {
		const match = resolveCalendar(calendars, spoken, "Daily Life", { sock: "SOC" });
		expect(match.ok && match.calendar.name).toBe("SOC");
	});

	it("ignores malformed settings instead of crashing", () => {
		const env = testEnv({ CALENDAR_ALIASES: "nope" as unknown as object, MEET_CALENDARS: [] });
		expect(calendarSettings(env)).toEqual({ aliases: {}, meetCalendars: [] });
	});
});

describe("jarvis_get_events", () => {
	it("lists tomorrow's events across visible calendars, in time order", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(
				{
					summary: "Dinner with Sam",
					start: { dateTime: "2026-11-02T19:00:00-05:00" },
					end: { dateTime: "2026-11-02T20:00:00-05:00" },
				},
				{ summary: "Pay rent", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } },
			),
			"/calendars/work-id/events": eventsAt({
				summary: "Standup",
				start: { dateTime: "2026-11-02T09:30:00-05:00" },
				end: { dateTime: "2026-11-02T09:45:00-05:00" },
			}),
		});

		const result = await getEventsTool.handler({ date: "2026-11-02" }, context());

		expect(resultText(result)).toBe(
			"Tomorrow you have 3 events: all day, Pay rent; 9:30 AM, Standup; 7 PM, Dinner with Sam.",
		);
		const queried = requests
			.filter((r) => r.url.pathname.endsWith("/events"))
			.map((r) => r.url.pathname);
		expect(queried).not.toContain("/calendar/v3/calendars/hidden-id/events");
		const query = requests.find((r) => r.url.pathname.includes("daily-id"))!.url.searchParams;
		expect(query.get("timeMin")).toBe("2026-11-02T05:00:00.000Z");
		expect(query.get("timeMax")).toBe("2026-11-03T05:00:00.000Z");
		expect(query.get("singleEvents")).toBe("true");
	});

	it("defaults to today and says when there's nothing on", async () => {
		fakeCalendar();
		const result = await getEventsTool.handler({}, context());
		expect(resultText(result)).toBe("Nothing on your calendar today.");
	});

	it("groups several days by date", async () => {
		fakeCalendar({
			"/calendars/daily-id/events": eventsAt(
				{
					summary: "Gym",
					start: { dateTime: "2026-11-03T07:00:00-05:00" },
					end: { dateTime: "2026-11-03T08:00:00-05:00" },
				},
				{
					summary: "Dentist",
					start: { dateTime: "2026-11-04T14:00:00-05:00" },
					end: { dateTime: "2026-11-04T15:00:00-05:00" },
				},
			),
		});

		const result = await getEventsTool.handler({ date: "2026-11-03", days: 2 }, context());

		expect(resultText(result)).toBe(
			"Tuesday, November 3 through Wednesday, November 4 you have 2 events: Tuesday, November 3: 7 AM, Gym. Wednesday, November 4: 2 PM, Dentist.",
		);
	});

	it("reads only the named calendar when asked", async () => {
		const requests = fakeCalendar();
		await getEventsTool.handler({ calendar: "work" }, context());
		const queried = requests.filter((r) => r.url.pathname.endsWith("/events"));
		expect(queried.map((r) => r.url.pathname)).toEqual([
			"/calendar/v3/calendars/work-id/events",
		]);
	});

	it("still answers when one calendar can't be read, and says so", async () => {
		fakeCalendar({ "/calendars/holidays-id/events": () => jsonResponse({}, 404) });
		const result = await getEventsTool.handler({}, context());
		expect(resultText(result)).toBe(
			"Nothing on your calendar today. I couldn't read one calendar.",
		);
	});

	it("skips cancelled events", async () => {
		fakeCalendar({
			"/calendars/daily-id/events": eventsAt({
				summary: "Cancelled thing",
				status: "cancelled",
				start: { dateTime: "2026-11-01T12:00:00-05:00" },
				end: { dateTime: "2026-11-01T13:00:00-05:00" },
			}),
		});
		const result = await getEventsTool.handler({}, context());
		expect(resultText(result)).toBe("Nothing on your calendar today.");
	});
});

describe("resolveCalendar with the owner's real calendar names", () => {
	const names = ["Waresport", "Career", "Class", "Daily Life", "Exams", "Research", "SOC"];
	const calendars = names.map((name) => ({
		id: `${name}-id`,
		name,
		primary: false,
		selected: true,
		canWrite: true,
	}));

	it.each([
		["Waresport", "Waresport"],
		["wares port", "Waresport"],
		["Wares-Port calendar", "Waresport"],
		["soc", "SOC"],
		["S.O.C.", "SOC"],
		["S O C", "SOC"],
		["class", "Class"],
		["exams calendar", "Exams"],
		["daily life", "Daily Life"],
		["dailylife", "Daily Life"],
		["research", "Research"],
		["career", "Career"],
	])("matches %j to %s", (spoken, expected) => {
		const match = resolveCalendar(calendars, spoken, "Daily Life");
		expect(match.ok && match.calendar.name).toBe(expected);
	});

	it("uses Daily Life when no calendar is named", () => {
		const match = resolveCalendar(calendars, undefined, "Daily Life");
		expect(match.ok && match.calendar.name).toBe("Daily Life");
	});

	it("doesn't guess on an unknown name", () => {
		const match = resolveCalendar(calendars, "Gym", "Daily Life");
		expect(match.ok).toBe(false);
	});
});

describe("jarvis_list_calendars", () => {
	it("lists calendars by name and marks the default", async () => {
		fakeCalendar();
		const result = await listCalendarsTool.handler({}, context());
		expect(resultText(result)).toBe(
			"You have 5 calendars: owner@example.com, Daily Life (your default), Work Calendar, Holidays in United States and Old Project.",
		);
	});
});

describe("repeating events and Meet links on any calendar", () => {
	it("creates a weekly repeat, starting on the first chosen weekday", async () => {
		const requests = fakeCalendar();

		const result = await addEventTool.handler(
			{
				title: "Gym",
				date: "2026-11-01", // a Sunday
				start_time: "07:00",
				repeat: { frequency: "weekly", days_of_week: ["MO", "WE"], until: "2026-12-16" },
			},
			context(),
		);

		expect(resultText(result)).toBe(
			'Added "Gym" to Daily Life starting Monday, November 2, 7 to 8 AM, repeating every Monday and Wednesday until Wednesday, December 16.',
		);
		const body = requests.find((r) => r.method === "POST")!.body as Record<string, unknown>;
		expect(body.start).toEqual({
			dateTime: "2026-11-02T07:00:00",
			timeZone: "America/New_York",
		});
		// End of Dec 16 in New York (EST) is 04:59:59 UTC on Dec 17.
		expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261217T045959Z"]);
	});

	it("rejects contradictory repeat settings before calling Google", async () => {
		const requests = fakeCalendar();
		const result = await addEventTool.handler(
			{
				title: "Gym",
				date: "2026-11-02",
				start_time: "07:00",
				repeat: { frequency: "weekly", until: "2026-12-01", count: 5 },
			},
			context(),
		);
		expect(result.isError).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("adds a Meet link to any calendar when asked", async () => {
		const requests = fakeCalendar({
			"POST /calendars/daily-id/events": () =>
				jsonResponse({ id: "evt", hangoutLink: "https://meet.google.com/x" }),
		});

		const result = await addEventTool.handler(
			{
				title: "Call with Mom",
				date: "2026-11-03",
				start_time: "18:00",
				add_meet_link: true,
			},
			context(),
		);

		expect(resultText(result)).toContain("with a Google Meet link");
		expect(requests.find((r) => r.method === "POST")!.body).toHaveProperty("conferenceData");
	});

	it("skips the automatic Meet link when told not to add one", async () => {
		const requests = fakeCalendar({
			"/users/me/calendarList": () =>
				jsonResponse({
					items: [
						...CALENDAR_LIST.items,
						{
							id: "waresport-id",
							summary: "Waresport",
							selected: true,
							accessRole: "owner",
						},
					],
				}),
		});

		await addEventTool.handler(
			{
				title: "Solo work",
				date: "2026-11-03",
				start_time: "10:00",
				calendar: "Waresport",
				add_meet_link: false,
			},
			context(),
		);

		expect(requests.find((r) => r.method === "POST")!.body).not.toHaveProperty(
			"conferenceData",
		);
	});
});

const DINNER = {
	id: "dinner-1",
	summary: "Dinner with Sam",
	start: { dateTime: "2026-11-06T19:00:00-05:00" },
	end: { dateTime: "2026-11-06T20:00:00-05:00" },
};

/** Echoes a PATCH body back as the updated event, like Google does. */
function patchEcho(base: Record<string, unknown>) {
	return (req: Recorded) => {
		const body = req.body as Record<string, unknown>;
		const toGoogle = (time: unknown) => {
			const t = time as { dateTime?: string; date?: string } | undefined;
			if (!t) return undefined;
			if (t.date) return { date: t.date };
			// Wall-clock in New York in November is UTC-5.
			return { dateTime: `${t.dateTime}-05:00` };
		};
		return jsonResponse({
			...base,
			...(body.summary ? { summary: body.summary } : {}),
			...(body.start ? { start: toGoogle(body.start) } : {}),
			...(body.end ? { end: toGoogle(body.end) } : {}),
			...(body.conferenceData ? { hangoutLink: "https://meet.google.com/x" } : {}),
			...(body.conferenceData === null ? { hangoutLink: undefined } : {}),
			...(body.recurrence !== undefined ? { recurrence: body.recurrence } : {}),
		});
	};
}

describe("jarvis_update_event", () => {
	it("moves an event to a new time and keeps its length", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(DINNER),
			"PATCH /calendars/daily-id/events/dinner-1": patchEcho(DINNER),
		});

		const result = await updateEventTool.handler(
			{ title: "dinner", date: "2026-11-06", new_start_time: "20:00" },
			context(),
		);

		expect(resultText(result)).toBe(
			`Updated "Dinner with Sam": it's now on Friday, November 6, 8 to 9 PM.`,
		);
		expectSpeakable(result);
		const search = requests.find((r) => r.url.pathname.endsWith("daily-id/events"))!;
		expect(search.url.searchParams.get("q")).toBe("dinner");
		const patch = requests.find((r) => r.method === "PATCH")!;
		expect(patch.body).toEqual({
			start: { dateTime: "2026-11-06T20:00:00", timeZone: "America/New_York" },
			end: { dateTime: "2026-11-06T21:00:00", timeZone: "America/New_York" },
		});
	});

	it("moves an event to another day at the same time", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(DINNER),
			"PATCH /calendars/daily-id/events/dinner-1": patchEcho(DINNER),
		});

		const result = await updateEventTool.handler(
			{ title: "dinner with sam", new_date: "2026-11-07" },
			context(),
		);

		expect(resultText(result)).toContain("Saturday, November 7, 7 to 8 PM");
		expect(
			(requests.find((r) => r.method === "PATCH")!.body as { start: unknown }).start,
		).toEqual({
			dateTime: "2026-11-07T19:00:00",
			timeZone: "America/New_York",
		});
	});

	it("asks which one when different events match", async () => {
		fakeCalendar({
			"/calendars/daily-id/events": eventsAt(
				{ ...DINNER, id: "a", summary: "Team meeting" },
				{
					...DINNER,
					id: "b",
					summary: "Meeting with advisor",
					start: { dateTime: "2026-11-06T10:00:00-05:00" },
					end: { dateTime: "2026-11-06T11:00:00-05:00" },
				},
			),
		});

		const result = await updateEventTool.handler(
			{ title: "meeting", new_start_time: "15:00" },
			context(),
		);

		expect(result.isError).toBe(true);
		expect(resultText(result)).toBe(
			'I found 2 events matching "meeting": Meeting with advisor on Friday, November 6, 10 to 11 AM; Team meeting on Friday, November 6, 7 to 8 PM. Which one?',
		);
	});

	it("narrows same-named events by their current start time", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(
				{ ...DINNER, id: "a", summary: "Meeting" },
				{
					...DINNER,
					id: "b",
					summary: "Meeting",
					start: { dateTime: "2026-11-06T10:00:00-05:00" },
					end: { dateTime: "2026-11-06T11:00:00-05:00" },
				},
			),
			"PATCH /calendars/daily-id/events/b": patchEcho({
				...DINNER,
				id: "b",
				summary: "Meeting",
			}),
		});

		await updateEventTool.handler(
			{ title: "meeting", start_time: "10:00", new_title: "Advisor meeting" },
			context(),
		);

		expect(requests.find((r) => r.method === "PATCH")!.url.pathname).toContain("/events/b");
	});

	it("says when it can't find the event", async () => {
		fakeCalendar();
		const result = await updateEventTool.handler(
			{ title: "yoga", date: "2026-11-06", new_start_time: "09:00" },
			context(),
		);
		expect(resultText(result)).toBe(
			`I couldn't find an event called "yoga" on Friday, November 6.`,
		);
	});

	it("changes every occurrence of a repeating event when asked", async () => {
		const occurrence = {
			...DINNER,
			id: "gym_20261106",
			summary: "Gym",
			recurringEventId: "gym",
		};
		const series = {
			id: "gym",
			summary: "Gym",
			recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"],
			start: { dateTime: "2026-11-02T07:00:00-05:00", timeZone: "America/New_York" },
			end: { dateTime: "2026-11-02T08:00:00-05:00", timeZone: "America/New_York" },
		};
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(occurrence),
			"/calendars/daily-id/events/gym": (req) =>
				req.method === "PATCH" ? patchEcho(series)(req) : jsonResponse(series),
		});

		const result = await updateEventTool.handler(
			{ title: "gym", new_start_time: "06:30", scope: "all" },
			context(),
		);

		expect(resultText(result)).toBe('Updated "Gym": every occurrence is now 6:30 to 7:30 AM.');
		const patch = requests.find((r) => r.method === "PATCH")!;
		expect(patch.url.pathname).toBe("/calendar/v3/calendars/daily-id/events/gym");
		expect((patch.body as { start: unknown }).start).toEqual({
			dateTime: "2026-11-02T06:30:00",
			timeZone: "America/New_York",
		});
	});

	it("won't move a whole series to another day", async () => {
		const occurrence = { ...DINNER, id: "gym_1", summary: "Gym", recurringEventId: "gym" };
		fakeCalendar({
			"/calendars/daily-id/events": eventsAt(occurrence),
			"/calendars/daily-id/events/gym": () =>
				jsonResponse({
					...DINNER,
					id: "gym",
					summary: "Gym",
					recurrence: ["RRULE:FREQ=DAILY"],
				}),
		});
		const result = await updateEventTool.handler(
			{ title: "gym", new_date: "2026-11-10", scope: "all" },
			context(),
		);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("delete it and add it again");
	});

	it("moves an event to another calendar", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(DINNER),
			"/calendars/daily-id/events/dinner-1/move": () => jsonResponse(DINNER),
		});

		const result = await updateEventTool.handler(
			{ title: "dinner", move_to_calendar: "work" },
			context(),
		);

		expect(resultText(result)).toBe(
			`Updated "Dinner with Sam": it's now on Friday, November 6, 7 to 8 PM, in Work Calendar.`,
		);
		const move = requests.find((r) => r.url.pathname.endsWith("/move"))!;
		expect(move.method).toBe("POST");
		expect(move.url.searchParams.get("destination")).toBe("work-id");
	});

	it("won't move one occurrence of a repeating event to another calendar", async () => {
		fakeCalendar({
			"/calendars/daily-id/events": eventsAt({ ...DINNER, recurringEventId: "series" }),
		});
		const result = await updateEventTool.handler(
			{ title: "dinner", move_to_calendar: "work" },
			context(),
		);
		expect(resultText(result)).toContain("Should I move all of them?");
	});

	it("adds a Meet link to an existing event", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(DINNER),
			"PATCH /calendars/daily-id/events/dinner-1": patchEcho(DINNER),
		});

		const result = await updateEventTool.handler(
			{ title: "dinner", add_meet_link: true },
			context(),
		);

		expect(resultText(result)).toContain("with a Google Meet link");
		const patch = requests.find((r) => r.method === "PATCH")!;
		expect(patch.url.searchParams.get("conferenceDataVersion")).toBe("1");
	});

	it("asks what to change when nothing was given", async () => {
		const result = await updateEventTool.handler({ title: "dinner" }, context());
		expect(resultText(result)).toBe("What should I change about that event?");
	});
});

describe("jarvis_delete_event", () => {
	it("deletes one event and says exactly which", async () => {
		const requests = fakeCalendar({ "/calendars/daily-id/events": eventsAt(DINNER) });

		const result = await deleteEventTool.handler(
			{ title: "dinner", date: "2026-11-06" },
			context(),
		);

		expect(resultText(result)).toBe(
			'Deleted "Dinner with Sam" on Friday, November 6, 7 to 8 PM from Daily Life.',
		);
		const del = requests.find((r) => r.method === "DELETE")!;
		expect(del.url.pathname).toBe("/calendar/v3/calendars/daily-id/events/dinner-1");
	});

	it("deletes a whole repeating series only when asked for all of them", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt({
				...DINNER,
				summary: "Gym",
				recurringEventId: "gym",
			}),
		});

		const result = await deleteEventTool.handler({ title: "gym", scope: "all" }, context());

		expect(resultText(result)).toBe('Deleted every "Gym" from Daily Life.');
		expect(requests.find((r) => r.method === "DELETE")!.url.pathname).toContain("/events/gym");
	});

	it("deletes just one occurrence by default", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt({
				...DINNER,
				id: "gym_1",
				summary: "Gym",
				recurringEventId: "gym",
			}),
		});
		await deleteEventTool.handler({ title: "gym" }, context());
		expect(requests.find((r) => r.method === "DELETE")!.url.pathname).toContain(
			"/events/gym_1",
		);
	});

	it("is marked destructive and tells Claude to confirm first", () => {
		expect(deleteEventTool.annotations?.destructiveHint).toBe(true);
		const description = deleteEventTool.description;
		const text = typeof description === "function" ? description(context()) : description;
		expect(text).toContain("wait for the user to confirm");
	});
});

describe("changing how events repeat, and removing Meet links", () => {
	const GYM_SERIES = {
		id: "gym",
		summary: "Gym",
		recurrence: [
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
			"EXDATE;TZID=America/New_York:20261014T070000",
		],
		start: { dateTime: "2026-10-05T07:00:00-04:00", timeZone: "America/New_York" },
		end: { dateTime: "2026-10-05T08:00:00-04:00", timeZone: "America/New_York" },
	};
	const GYM_OCCURRENCE = {
		id: "gym_20261102",
		summary: "Gym",
		recurringEventId: "gym",
		start: { dateTime: "2026-11-02T07:00:00-05:00" },
		end: { dateTime: "2026-11-02T08:00:00-05:00" },
	};

	it("turns a one-off event into a weekly one", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(DINNER),
			"PATCH /calendars/daily-id/events/dinner-1": patchEcho(DINNER),
		});

		const result = await updateEventTool.handler(
			{ title: "dinner with sam", repeat: { frequency: "weekly" } },
			context(),
		);

		expect(resultText(result)).toBe(
			'Updated "Dinner with Sam": it now repeats every Friday, starting Friday, November 6, 7 to 8 PM.',
		);
		const patch = requests.find((r) => r.method === "PATCH")!;
		expect(patch.body).toEqual({ recurrence: ["RRULE:FREQ=WEEKLY"] });
	});

	it("moves the first occurrence onto the chosen weekdays when making it repeat", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(DINNER), // a Friday
			"PATCH /calendars/daily-id/events/dinner-1": patchEcho(DINNER),
		});

		await updateEventTool.handler(
			{
				title: "dinner",
				repeat: { frequency: "weekly", days_of_week: ["MO", "WE"], count: 6 },
			},
			context(),
		);

		const body = requests.find((r) => r.method === "PATCH")!.body as Record<string, unknown>;
		expect(body.start).toEqual({
			dateTime: "2026-11-09T19:00:00",
			timeZone: "America/New_York",
		});
		expect(body.end).toEqual({ dateTime: "2026-11-09T20:00:00", timeZone: "America/New_York" });
		expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6"]);
	});

	it("changes the pattern of the whole series, even when one occurrence was named", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(GYM_OCCURRENCE),
			"/calendars/daily-id/events/gym": (req) =>
				req.method === "PATCH" ? patchEcho(GYM_SERIES)(req) : jsonResponse(GYM_SERIES),
		});

		const result = await updateEventTool.handler(
			{ title: "gym", repeat: { frequency: "weekly", days_of_week: ["MO", "WE"] } },
			context(),
		);

		expect(resultText(result)).toContain("it now repeats every Monday and Wednesday");
		const patch = requests.find((r) => r.method === "PATCH")!;
		expect(patch.url.pathname).toBe("/calendar/v3/calendars/daily-id/events/gym");
		expect((patch.body as { recurrence: string[] }).recurrence).toEqual([
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
		]);
	});

	it("stops a series after today and keeps its exceptions", async () => {
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(GYM_OCCURRENCE),
			"/calendars/daily-id/events/gym": (req) =>
				req.method === "PATCH" ? patchEcho(GYM_SERIES)(req) : jsonResponse(GYM_SERIES),
		});

		const result = await updateEventTool.handler(
			{ title: "gym", stop_repeating: true },
			context(),
		);

		expect(resultText(result)).toBe('Updated "Gym": it no longer repeats after today.');
		const patch = requests.find((r) => r.method === "PATCH")!;
		// Today is Sunday, November 1; its end in New York (EST) is 04:59:59 UTC on November 2.
		expect((patch.body as { recurrence: string[] }).recurrence).toEqual([
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261102T045959Z",
			"EXDATE;TZID=America/New_York:20261014T070000",
		]);
	});

	it("replaces an existing end date or count when stopping", async () => {
		const series = { ...GYM_SERIES, recurrence: ["RRULE:FREQ=DAILY;COUNT=200"] };
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(GYM_OCCURRENCE),
			"/calendars/daily-id/events/gym": (req) =>
				req.method === "PATCH" ? patchEcho(series)(req) : jsonResponse(series),
		});

		await updateEventTool.handler({ title: "gym", stop_repeating: true }, context());

		expect(
			(requests.find((r) => r.method === "PATCH")!.body as { recurrence: string[] })
				.recurrence,
		).toEqual(["RRULE:FREQ=DAILY;UNTIL=20261102T045959Z"]);
	});

	it("turns a series that hasn't started yet into a single event", async () => {
		const future = {
			...GYM_SERIES,
			start: { dateTime: "2026-11-02T07:00:00-05:00", timeZone: "America/New_York" },
			end: { dateTime: "2026-11-02T08:00:00-05:00", timeZone: "America/New_York" },
		};
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(GYM_OCCURRENCE),
			"/calendars/daily-id/events/gym": (req) =>
				req.method === "PATCH" ? patchEcho(future)(req) : jsonResponse(future),
		});

		const result = await updateEventTool.handler(
			{ title: "gym", stop_repeating: true },
			context(),
		);

		expect(resultText(result)).toBe(
			`Updated "Gym": it no longer repeats; it's just on Monday, November 2, 7 to 8 AM.`,
		);
		expect(requests.find((r) => r.method === "PATCH")!.body).toEqual({ recurrence: [] });
	});

	it("says so when asked to stop an event that doesn't repeat", async () => {
		const requests = fakeCalendar({ "/calendars/daily-id/events": eventsAt(DINNER) });
		const result = await updateEventTool.handler(
			{ title: "dinner", stop_repeating: true },
			context(),
		);
		expect(resultText(result)).toBe('"Dinner with Sam" doesn\'t repeat.');
		expect(requests.some((r) => r.method === "PATCH")).toBe(false);
	});

	it("removes a Meet link", async () => {
		const withMeet = { ...DINNER, hangoutLink: "https://meet.google.com/abc" };
		const requests = fakeCalendar({
			"/calendars/daily-id/events": eventsAt(withMeet),
			"PATCH /calendars/daily-id/events/dinner-1": patchEcho(withMeet),
		});

		const result = await updateEventTool.handler(
			{ title: "dinner", add_meet_link: false },
			context(),
		);

		expect(resultText(result)).toBe(
			'Updated "Dinner with Sam": it\'s now on Friday, November 6, 7 to 8 PM, without a Meet link.',
		);
		const patch = requests.find((r) => r.method === "PATCH")!;
		expect(patch.url.searchParams.get("conferenceDataVersion")).toBe("1");
		expect(patch.body).toEqual({ conferenceData: null });
	});

	it("doesn't call Google when there's no Meet link to remove", async () => {
		const requests = fakeCalendar({ "/calendars/daily-id/events": eventsAt(DINNER) });
		const result = await updateEventTool.handler(
			{ title: "dinner", add_meet_link: false },
			context(),
		);
		expect(resultText(result)).toBe(`"Dinner with Sam" doesn't have a Google Meet link.`);
		expect(requests.some((r) => r.method === "PATCH")).toBe(false);
	});

	it("rejects a new pattern and stopping at the same time", async () => {
		const result = await updateEventTool.handler(
			{ title: "gym", repeat: { frequency: "daily" }, stop_repeating: true },
			context(),
		);
		expect(result.isError).toBe(true);
	});
});
