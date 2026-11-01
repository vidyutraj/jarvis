import { describe, expect, it } from "vitest";
import {
	buildRrule,
	endRecurrence,
	firstOccurrence,
	speakRepeat,
	validateRepeat,
} from "../src/lib/recurrence";

const NY = { allDay: false, timeZone: "America/New_York" };

describe("buildRrule", () => {
	it("builds weekly rules with chosen days and a UTC end for timed events", () => {
		expect(
			buildRrule(
				{ frequency: "weekly", days_of_week: ["MO", "WE"], until: "2026-12-15" },
				NY,
			),
		).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261216T045959Z");
	});

	it("uses a plain date end for all-day events", () => {
		expect(
			buildRrule(
				{ frequency: "yearly", until: "2030-05-01" },
				{ allDay: true, timeZone: "America/New_York" },
			),
		).toBe("RRULE:FREQ=YEARLY;UNTIL=20300501");
	});

	it("handles intervals and counts", () => {
		expect(buildRrule({ frequency: "daily", interval: 2, count: 10 }, NY)).toBe(
			"RRULE:FREQ=DAILY;INTERVAL=2;COUNT=10",
		);
		expect(buildRrule({ frequency: "monthly" }, NY)).toBe("RRULE:FREQ=MONTHLY");
	});

	it("uses EDT for an end date in summer", () => {
		expect(buildRrule({ frequency: "daily", until: "2027-06-30" }, NY)).toBe(
			"RRULE:FREQ=DAILY;UNTIL=20270701T035959Z",
		);
	});
});

describe("firstOccurrence", () => {
	it("moves the start to the first chosen weekday", () => {
		expect(
			firstOccurrence("2026-11-01", { frequency: "weekly", days_of_week: ["MO", "WE"] }),
		).toBe("2026-11-02");
		expect(
			firstOccurrence("2026-11-04", { frequency: "weekly", days_of_week: ["MO", "WE"] }),
		).toBe("2026-11-04");
		expect(firstOccurrence("2026-11-01", { frequency: "daily" })).toBe("2026-11-01");
	});
});

describe("validateRepeat", () => {
	it("catches contradictions", () => {
		expect(
			validateRepeat({ frequency: "weekly", until: "2026-12-01", count: 3 }, "2026-11-01"),
		).toBeTruthy();
		expect(
			validateRepeat({ frequency: "weekly", until: "2026-10-01" }, "2026-11-01"),
		).toBeTruthy();
		expect(
			validateRepeat({ frequency: "daily", days_of_week: ["MO"] }, "2026-11-01"),
		).toBeTruthy();
		expect(
			validateRepeat({ frequency: "weekly", days_of_week: ["MO"] }, "2026-11-01"),
		).toBeNull();
	});
});

describe("speakRepeat", () => {
	it("reads repeats back naturally", () => {
		expect(speakRepeat({ frequency: "weekly" }, "2026-11-06")).toBe("every Friday");
		expect(
			speakRepeat(
				{ frequency: "weekly", days_of_week: ["TU", "TH"], interval: 2 },
				"2026-11-03",
			),
		).toBe("every 2 weeks on Tuesday and Thursday");
		expect(speakRepeat({ frequency: "daily", interval: 2, count: 10 }, "2026-11-01")).toBe(
			"every 2 days, 10 times",
		);
		expect(speakRepeat({ frequency: "monthly", until: "2027-05-01" }, "2026-11-01")).toBe(
			"every month until Saturday, May 1",
		);
	});
});

describe("endRecurrence", () => {
	it("uses a plain date for all-day series and leaves other lines alone", () => {
		expect(
			endRecurrence(
				["RRULE:FREQ=YEARLY;UNTIL=20400101", "RDATE;VALUE=DATE:20261225"],
				"2026-12-31",
				{
					allDay: true,
					timeZone: "America/New_York",
				},
			),
		).toEqual(["RRULE:FREQ=YEARLY;UNTIL=20261231", "RDATE;VALUE=DATE:20261225"]);
	});
});
