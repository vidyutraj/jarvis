import { describe, expect, it } from "vitest";
import {
	addDays,
	addMinutes,
	isValidDate,
	isValidTime,
	localParts,
	longDate,
	speakDay,
	speakTime,
	startOfLocalDay,
	todayIn,
} from "../src/lib/dates";

const NY = "America/New_York";

describe("date validation", () => {
	it("accepts real dates and rejects impossible ones", () => {
		expect(isValidDate("2026-11-06")).toBe(true);
		expect(isValidDate("2028-02-29")).toBe(true);
		expect(isValidDate("2026-02-30")).toBe(false);
		expect(isValidDate("2026-13-01")).toBe(false);
		expect(isValidDate("11/06/2026")).toBe(false);
	});

	it("accepts 24-hour times only", () => {
		expect(isValidTime("00:00")).toBe(true);
		expect(isValidTime("23:59")).toBe(true);
		expect(isValidTime("24:00")).toBe(false);
		expect(isValidTime("7pm")).toBe(false);
	});
});

describe("date arithmetic", () => {
	it("adds days across month and year ends", () => {
		expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
	});

	it("adds minutes and rolls past midnight", () => {
		expect(addMinutes("2026-11-06", "19:00", 60)).toEqual({
			date: "2026-11-06",
			time: "20:00",
		});
		expect(addMinutes("2026-11-06", "23:30", 90)).toEqual({
			date: "2026-11-07",
			time: "01:00",
		});
	});
});

describe("time zones", () => {
	it("knows today's date in New York, not UTC", () => {
		// 03:00 UTC on Nov 2 is still the evening of Nov 1 in New York.
		expect(todayIn(NY, new Date("2026-11-02T03:00:00Z"))).toBe("2026-11-01");
	});

	it("finds the start of a local day on both sides of the November DST change", () => {
		expect(startOfLocalDay("2026-10-31", NY)).toBe("2026-10-31T04:00:00.000Z"); // EDT, UTC-4
		expect(startOfLocalDay("2026-11-02", NY)).toBe("2026-11-02T05:00:00.000Z"); // EST, UTC-5
	});

	it("finds the start of a local day on both sides of the March DST change", () => {
		expect(startOfLocalDay("2026-03-08", NY)).toBe("2026-03-08T05:00:00.000Z"); // EST
		expect(startOfLocalDay("2026-03-09", NY)).toBe("2026-03-09T04:00:00.000Z"); // EDT
	});

	it("converts an event instant to New York wall-clock time", () => {
		expect(localParts(new Date("2026-11-07T00:00:00Z"), NY)).toEqual({
			date: "2026-11-06",
			time: "19:00",
		});
	});
});

describe("spoken formats", () => {
	it("speaks times naturally", () => {
		expect(speakTime("19:00")).toBe("7 PM");
		expect(speakTime("09:30")).toBe("9:30 AM");
		expect(speakTime("12:00")).toBe("12 PM");
		expect(speakTime("00:15")).toBe("12:15 AM");
	});

	it("speaks days relative to today", () => {
		expect(speakDay("2026-11-01", "2026-11-01")).toBe("today");
		expect(speakDay("2026-11-02", "2026-11-01")).toBe("tomorrow");
		expect(speakDay("2026-11-06", "2026-11-01")).toBe("Friday, November 6");
	});

	it("adds the year only when it differs", () => {
		expect(longDate("2027-01-04", 2026)).toBe("Monday, January 4, 2027");
		expect(longDate("2026-11-06", 2026)).toBe("Friday, November 6");
	});
});
