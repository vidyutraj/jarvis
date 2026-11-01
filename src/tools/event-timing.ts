import { addDays, addMinutes, longDate, minutesOfDay } from "../lib/dates";
import type { NewEvent } from "../lib/google-calendar";
import { speakTimeRange } from "./calendar-common";

export const DEFAULT_DURATION_MINUTES = 60;

export interface TimingArgs {
	date: string;
	start_time?: string;
	end_time?: string;
	duration_minutes?: number;
}

export interface Timing {
	event: Pick<NewEvent, "start" | "end">;
	allDay: boolean;
	/** "Friday, November 6, 7 to 8 PM" or "Friday, November 6, all day". */
	when: string;
}

/**
 * Turns a date plus optional times into Google's start/end. Timed events are sent
 * as wall-clock time plus the time zone, so Google handles daylight saving.
 */
export function buildTiming(args: TimingArgs, timeZone: string): Timing {
	if (!args.start_time) {
		return {
			// Google's all-day end date is exclusive.
			event: { start: { date: args.date }, end: { date: addDays(args.date, 1) } },
			allDay: true,
			when: `${longDate(args.date)}, all day`,
		};
	}

	const start = { date: args.date, time: args.start_time };
	let end: { date: string; time: string };
	if (args.end_time) {
		const endsNextDay = minutesOfDay(args.end_time) <= minutesOfDay(args.start_time);
		end = { date: endsNextDay ? addDays(args.date, 1) : args.date, time: args.end_time };
	} else {
		end = addMinutes(
			args.date,
			args.start_time,
			args.duration_minutes ?? DEFAULT_DURATION_MINUTES,
		);
	}

	return {
		event: {
			start: { dateTime: `${start.date}T${start.time}:00`, timeZone },
			end: { dateTime: `${end.date}T${end.time}:00`, timeZone },
		},
		allDay: false,
		when: `${longDate(start.date)}, ${speakTimeRange(start.time, end.time)}`,
	};
}
