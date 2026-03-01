import { useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent
} from "react";
import { ApiClient } from "./api";
import type {
  CalendarEvent as BackendCalendarEvent,
  EnergyInterval,
  EnergyProfile,
  UserState
} from "./types";

type ViewMode = "week" | "month" | "day" | "3days";
type TopTab = "calendar" | "insights";
type EnergyTab = "day" | "week" | "month" | "year";
type SidebarMode = "chat" | "todo";
type ColorClass = "dark" | "light" | "blue" | "green" | "blueLight" | "greenLight";
type PriorityTag = "High" | "Medium" | "Low";
type PlannerItemKind = "todo" | "deadline";
type PlannerCategory = "Exams" | "Homework" | "Study" | "General";
type PlannerCadence = "once" | "weekdays" | "daily" | "times_per_week";

type EventItem = {
  id: number;
  backendId?: string;
  sourcePlannerItemId?: number;
  date: string;
  sh: number;
  eh: number;
  title: string;
  c: ColorClass;
  done: boolean;
};

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
};

type EventPopupState = {
  open: boolean;
  x: number;
  y: number;
  date: string;
  hour: number;
  name: string;
  location: string;
  start: string;
  end: string;
  color: ColorClass;
};

type EventEditorState = {
  open: boolean;
  eventId: number | null;
  date: string;
  title: string;
  start: string;
  end: string;
  color: ColorClass;
};

type GridAnim = "next" | "prev" | "fade";
type DragMode = "move" | "resize-start" | "resize-end";

type DragState = {
  target: "event" | "projected";
  itemId: number;
  mode: DragMode;
  startY: number;
  startSh: number;
  startEh: number;
  startDate: string;
  moved: boolean;
};

type PlannerItem = {
  id: number;
  title: string;
  kind: PlannerItemKind;
  category: PlannerCategory;
  priority: PriorityTag;
  dueDate: string;
  estimateMinutes: number;
  cadence: PlannerCadence;
  timesPerWeek?: number;
  fixedTime?: string | null;
  splitPreferred?: boolean;
  completed: boolean;
};

type ProjectedPlanBlock = {
  id: number;
  plannerItemId: number;
  title: string;
  date: string;
  sh: number;
  eh: number;
  priority: PriorityTag;
  reason: string;
  fixed?: boolean;
};

type HoverReasonAnchor = {
  x: number;
  y: number;
  side: "right" | "left";
};

const DEFAULT_API_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const DEFAULT_USER_ID = "user_123";
const TODAY = new Date();
const DAYS_FULL = ["Mon", "Tue", "Wed", "Thur", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
const HOUR_H = 84;
const START_H = 7;
const COLOR_ORDER: ColorClass[] = ["dark", "blue", "green"];
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const EMPTY_ENERGY_PROFILE: EnergyProfile = {
  version: 1,
  timezone: DEFAULT_TIMEZONE,
  intervals: [],
  freeform_notes: null,
  updated_at: null
};

const POPUP_START_H = START_H;
const POPUP_END_H = 22;
const POPUP_HOUR_H = 26;

function weekOf(date: Date): Date {
  const dow = date.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const start = new Date(date);
  start.setDate(date.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function fmtTime(hourFloat: number): string {
  const hi = Math.floor(hourFloat);
  const mi = Math.round((hourFloat - hi) * 60);
  return `${String(hi).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function parseTime(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h + m / 60;
}

function fromIsoToHour(date: Date): number {
  return date.getHours() + date.getMinutes() / 60;
}

function parseDateKey(dateKey: string): Date | null {
  const [yearStr, monthStr, dayStr] = dateKey.split("-");
  const year = Number.parseInt(yearStr ?? "", 10);
  const month = Number.parseInt(monthStr ?? "", 10);
  const day = Number.parseInt(dayStr ?? "", 10);
  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return new Date(year, month - 1, day);
}

function buildLocalDateTime(dateKey: string, hourFloat: number): Date | null {
  const baseDate = parseDateKey(dateKey);
  if (!baseDate || Number.isNaN(hourFloat)) {
    return null;
  }
  const totalMinutes = Math.max(0, Math.round(hourFloat * 60));
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  baseDate.setHours(hour, minute, 0, 0);
  return baseDate;
}

function eventColorFromSeed(seed: string): ColorClass {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return COLOR_ORDER[Math.abs(hash) % COLOR_ORDER.length];
}

function isTodoColor(color: ColorClass): boolean {
  return color === "light" || color === "blueLight" || color === "greenLight";
}

function summarizeEnergyProfileUpdate(
  previous: EnergyProfile,
  next: EnergyProfile,
  description: string
): string {
  const prevCount = previous.intervals.length;
  const nextCount = next.intervals.length;
  const delta = nextCount - prevCount;
  const hardBlocks = next.intervals.filter((interval) => interval.hard_block).length;
  const sample = next.intervals
    .slice(0, 3)
    .map((interval) => {
      const levelText = interval.hard_block
        ? "hard block"
        : `energy ${interval.energy_level > 0 ? `+${interval.energy_level}` : interval.energy_level}`;
      const label = interval.label?.trim() || interval.id;
      return `${label} ${interval.start_time}-${interval.end_time} (${levelText})`;
    })
    .join("; ");
  const inferredTakeaways: string[] = [];
  if (/\b(productive|focus|energ|alert)\b/i.test(description)) {
    inferredTakeaways.push("captured productive/focus windows");
  }
  if (/\b(tired|drained|low energy|slump)\b/i.test(description)) {
    inferredTakeaways.push("captured low-energy windows");
  }
  if (/\b(avoid|busy|blocked|cannot)\b/i.test(description)) {
    inferredTakeaways.push("added blocked times");
  }

  return [
    "Energy profile updated.",
    `Main changes: ${nextCount} interval${nextCount === 1 ? "" : "s"} (${delta >= 0 ? `+${delta}` : `${delta}`} vs previous), ${hardBlocks} hard block${hardBlocks === 1 ? "" : "s"}.`,
    `Detected windows: ${sample || "No structured windows were detected from this input."}`,
    `Takeaways: ${inferredTakeaways.length > 0 ? inferredTakeaways.join(", ") : "general routine notes were integrated."}`
  ].join("\n");
}

function colorForConfirmedBlock(block: ProjectedPlanBlock, item: PlannerItem | undefined): ColorClass {
  const title = `${block.title} ${item?.title ?? ""}`.toLowerCase();
  if (item?.category === "Exams" || /\bexam|quiz|test|examlet\b/.test(title)) {
    return "dark";
  }
  if (/\bwater\b/.test(title)) {
    return "blueLight";
  }
  if (/\barc\b|\bgym\b|\bworkout\b/.test(title)) {
    return "greenLight";
  }
  if (item?.category === "Homework" || /\bhomework|project|mp\b/.test(title)) {
    return "blueLight";
  }
  if (block.fixed) {
    return "blue";
  }
  return "light";
}

function withPreservedSuffix(existingTitle: string, nextBase: string): string {
  const suffixMatch = existingTitle.match(/\s\((Mon|Tue|Wed|Thu|Fri|Sat|Sun|Part \d+)\)$/);
  if (!suffixMatch) {
    return nextBase;
  }
  return `${nextBase} (${suffixMatch[1]})`;
}

const EVENT_META_MARKER = "__aura__";

function stripEventMetadataFromId(backendId: string): string {
  const [base] = backendId.split(EVENT_META_MARKER);
  return base || backendId;
}

function encodeEventMetadataIntoId(item: EventItem): string {
  const baseId = stripEventMetadataFromId(item.backendId ?? `calendar_${item.id}`);
  const meta: string[] = [`c=${item.c}`, `d=${item.done ? 1 : 0}`];
  if (item.sourcePlannerItemId !== undefined) {
    meta.push(`p=${item.sourcePlannerItemId}`);
  }
  return `${baseId}${EVENT_META_MARKER}${meta.join(";")}`;
}

function decodeEventMetadataFromId(
  backendId: string | null | undefined
): { baseId: string; color?: ColorClass; done?: boolean; plannerId?: number } {
  if (!backendId || !backendId.includes(EVENT_META_MARKER)) {
    return { baseId: backendId ?? "" };
  }
  const [baseId, metaPart] = backendId.split(EVENT_META_MARKER);
  const entries = (metaPart ?? "").split(";");
  const parsed: { baseId: string; color?: ColorClass; done?: boolean; plannerId?: number } = { baseId };
  for (const entry of entries) {
    const [rawKey, rawValue] = entry.split("=");
    const key = (rawKey ?? "").trim();
    const value = (rawValue ?? "").trim();
    if (key === "c" && value) {
      if (
        value === "dark" ||
        value === "light" ||
        value === "blue" ||
        value === "green" ||
        value === "blueLight" ||
        value === "greenLight"
      ) {
        parsed.color = value;
      }
    }
    if (key === "d") {
      parsed.done = value === "1";
    }
    if (key === "p") {
      const parsedPlannerId = Number(value);
      if (!Number.isNaN(parsedPlannerId)) {
        parsed.plannerId = parsedPlannerId;
      }
    }
  }
  return parsed;
}

function inferTodoItemFromEvents(plannerId: number, linkedEvents: EventItem[]): PlannerItem {
  const sorted = [...linkedEvents].sort((a, b) => a.date.localeCompare(b.date) || a.sh - b.sh);
  const first = sorted[0];
  const title = first.title.replace(/\s\((Mon|Tue|Wed|Thu|Fri|Sat|Sun|Part \d+)\)$/, "").trim();
  const done = sorted.every((eventItem) => eventItem.done);
  const dates = [...new Set(sorted.map((eventItem) => eventItem.date))];
  const cadence: PlannerCadence =
    dates.length >= 7 ? "daily" : dates.length >= 5 ? "weekdays" : dates.length >= 2 ? "times_per_week" : "once";
  const timesPerWeek = cadence === "times_per_week" ? dates.length : undefined;
  const category: PlannerCategory =
    /\bexam|quiz|test|examlet\b/i.test(title)
      ? "Exams"
      : /\bhomework|project|mp\b/i.test(title)
        ? "Homework"
        : /\bstudy|review|lesson\b/i.test(title)
          ? "Study"
          : "General";
  return {
    id: plannerId,
    title,
    kind: /\bexam|quiz|test|due|deadline\b/i.test(title) ? "deadline" : "todo",
    category,
    priority: category === "Exams" ? "High" : category === "Homework" ? "Medium" : "Low",
    dueDate: dates[dates.length - 1] ?? fmtDate(new Date()),
    estimateMinutes: Math.max(
      15,
      Math.round(
        (sorted.reduce((sum, eventItem) => sum + (eventItem.eh - eventItem.sh) * 60, 0) / Math.max(sorted.length, 1))
      )
    ),
    cadence,
    timesPerWeek,
    fixedTime: null,
    splitPreferred: false,
    completed: done
  };
}

function mapBackendEventsToUiEvents(calendarEvents: BackendCalendarEvent[]): EventItem[] {
  const sorted = [...calendarEvents].sort((a, b) => {
    const aTs = new Date(a.start).getTime();
    const bTs = new Date(b.start).getTime();
    return aTs - bTs;
  });

  const mapped: EventItem[] = [];
  let localId = 1;
  for (const item of sorted) {
    const start = new Date(item.start);
    const end = new Date(item.end);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end.getTime() <= start.getTime()
    ) {
      continue;
    }

    const sh = fromIsoToHour(start);
    const eh = Math.max(fromIsoToHour(end), sh + 0.25);
    const decoded = decodeEventMetadataFromId(item.id ?? null);
    const seed = decoded.baseId && decoded.baseId.trim() ? decoded.baseId : `${item.title}-${item.start}`;
    mapped.push({
      id: localId,
      backendId: decoded.baseId || item.id || `calendar_${localId}`,
      sourcePlannerItemId: decoded.plannerId,
      date: fmtDate(start),
      sh,
      eh,
      title: item.title,
      c: decoded.color ?? eventColorFromSeed(seed),
      done: decoded.done ?? false
    });
    localId += 1;
  }
  return mapped;
}

function mapUiEventsToBackendEvents(events: EventItem[]): BackendCalendarEvent[] {
  return events.reduce<BackendCalendarEvent[]>((result, item) => {
    const start = buildLocalDateTime(item.date, item.sh);
    const end = buildLocalDateTime(item.date, Math.max(item.eh, item.sh + 0.25));
    if (!start || !end || end <= start) {
      return result;
    }
    result.push({
      id: encodeEventMetadataIntoId(item),
      title: item.title,
      start: start.toISOString(),
      end: end.toISOString()
    });
    return result;
  }, []);
}

function snapQuarter(hour: number): number {
  return Math.round(hour * 4) / 4;
}

function colsForView(view: ViewMode): number {
  if (view === "week") {
    return 7;
  }
  if (view === "3days") {
    return 3;
  }
  return 1;
}

function getDatesForView(view: ViewMode, weekStart: Date, currentDate: Date): Date[] {
  if (view === "month") {
    return [];
  }
  const dates: Date[] = [];
  const cols = colsForView(view);
  const base = view === "week" ? new Date(weekStart) : new Date(currentDate);
  for (let i = 0; i < cols; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function buildPeriodTitle(view: ViewMode, weekStart: Date, currentDate: Date, monthDate: Date): string {
  if (view === "week") {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    if (weekStart.getMonth() === end.getMonth()) {
      return `${MONTHS[weekStart.getMonth()]} ${weekStart.getFullYear()}`;
    }
    return `${MONTHS[weekStart.getMonth()].slice(0, 3)} - ${MONTHS[end.getMonth()].slice(0, 3)} ${end.getFullYear()}`;
  }
  if (view === "day") {
    return currentDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
  }
  if (view === "3days") {
    const end = new Date(currentDate);
    end.setDate(end.getDate() + 2);
    return `${MONTHS[currentDate.getMonth()].slice(0, 3)} ${currentDate.getDate()}-${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${MONTHS[monthDate.getMonth()]} ${monthDate.getFullYear()}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unexpected error";
}

function parseRelativeDueDate(fragment: string, baseDate: Date): string {
  const text = fragment.toLowerCase();
  const next = new Date(baseDate);
  next.setHours(0, 0, 0, 0);
  if (text.includes("today")) {
    return fmtDate(next);
  }
  if (text.includes("tomorrow")) {
    next.setDate(next.getDate() + 1);
    return fmtDate(next);
  }
  const weekdayIndexMap: Record<string, number> = {
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
    sun: 0,
    sunday: 0
  };
  for (const [label, weekday] of Object.entries(weekdayIndexMap)) {
    if (text.includes(label)) {
      const delta = (weekday - next.getDay() + 7) % 7 || 7;
      next.setDate(next.getDate() + delta);
      return fmtDate(next);
    }
  }
  const explicitDateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (explicitDateMatch) {
    const month = Number(explicitDateMatch[1]);
    const day = Number(explicitDateMatch[2]);
    const yearPart = explicitDateMatch[3];
    const year = yearPart
      ? Number(yearPart.length === 2 ? `20${yearPart}` : yearPart)
      : next.getFullYear();
    const explicit = new Date(year, month - 1, day);
    if (!Number.isNaN(explicit.getTime())) {
      return fmtDate(explicit);
    }
  }
  const monthDayMatch = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/
  );
  if (monthDayMatch) {
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monthName = monthDayMatch[1].slice(0, 3).toLowerCase();
    const month = monthNames.indexOf(monthName);
    const day = Number(monthDayMatch[2]);
    if (month >= 0) {
      const explicit = new Date(next.getFullYear(), month, day);
      if (!Number.isNaN(explicit.getTime())) {
        return fmtDate(explicit);
      }
    }
  }
  const fallback = new Date(baseDate);
  fallback.setDate(fallback.getDate() + 5);
  return fmtDate(fallback);
}

function parsePriority(fragment: string): PriorityTag {
  const lower = fragment.toLowerCase();
  if (/\b(urgent|asap|critical|high)\b/.test(lower)) {
    return "High";
  }
  if (/\b(low|whenever|later)\b/.test(lower)) {
    return "Low";
  }
  return "Medium";
}

function parseEstimateMinutes(fragment: string): number {
  const lower = fragment.toLowerCase();
  const hoursMatch = lower.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (!Number.isNaN(hours)) {
      return Math.max(15, Math.round(hours * 60));
    }
  }
  const minutesMatch = lower.match(/(\d+)\s*(m|min|mins|minute|minutes)\b/);
  if (minutesMatch) {
    const minutes = Number(minutesMatch[1]);
    if (!Number.isNaN(minutes)) {
      return Math.max(15, minutes);
    }
  }
  if (/\b(call|email|follow up|reply)\b/.test(lower)) {
    return 30;
  }
  if (/\bstudy|review|project|assignment|write\b/.test(lower)) {
    return 90;
  }
  return 60;
}

function parseClockToHourFloat(text: string): number | null {
  if (/\bmidnight\b/i.test(text)) {
    return 23.9833;
  }
  if (/\bnoon\b/i.test(text)) {
    return 12;
  }
  const matches = [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)];
  for (const match of matches) {
    const rawHour = Number(match[1]);
    const rawMinute = Number(match[2] ?? "0");
    const meridiem = (match[3] ?? "").toLowerCase();
    if (Number.isNaN(rawHour) || Number.isNaN(rawMinute)) {
      continue;
    }
    let hour = rawHour;
    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (hour >= 0 && hour <= 23 && rawMinute <= 59) {
      return hour + rawMinute / 60;
    }
  }
  return null;
}

function splitTaskClauses(message: string): string[] {
  const cleaned = message.replace(/\r/g, "\n");
  return cleaned
    .split(/\n|;|•|\.(?=\s|$)|,/)
    .map((line) => line.replace(/^\s*(and|then)\s+/i, "").trim())
    .filter((line) => line.length > 0);
}

function normalizeCourseCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

function normalizeTaskTitle(line: string, course: string): string {
  const compactCourse = course ? normalizeCourseCode(course) : "";
  const lower = line.toLowerCase().replace(/\s+/g, " ");

  if (/\b(arc|gym)\b/i.test(line)) {
    return "ARC";
  }
  if (/\b(drink|water)\b/i.test(line)) {
    return "Drink water";
  }
  if (compactCourse && /\bdaily lessons?\b/i.test(line)) {
    return `${compactCourse} daily lesson`;
  }
  if (compactCourse && /\bhomework\b/i.test(line)) {
    return `${compactCourse} homework`;
  }
  if (compactCourse && /\bmachine project\b/i.test(line)) {
    return `${compactCourse} machine project`;
  }

  const cleaned = lower
    .replace(/\b(i need to|need to|have to|i have to|finish|complete|do|work on|go to|please|my)\b/g, "")
    .replace(/\b(daily|every day|each day|today|tomorrow)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (compactCourse && cleaned.length > 0) {
    return `${compactCourse} ${cleaned}`.trim();
  }
  return cleaned || (compactCourse ? compactCourse : line.trim());
}

function findNextWeekday(baseDate: Date, weekdayName: string): string {
  const map: Record<string, number> = {
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
    sunday: 0
  };
  const targetDow = map[weekdayName.toLowerCase()];
  if (targetDow === undefined) {
    return fmtDate(baseDate);
  }
  const next = new Date(baseDate);
  next.setHours(0, 0, 0, 0);
  const diff = (targetDow - next.getDay() + 7) % 7 || 7;
  next.setDate(next.getDate() + diff);
  return fmtDate(next);
}

function buildPlannerItem(input: {
  title: string;
  kind: PlannerItemKind;
  category: PlannerCategory;
  priority: PriorityTag;
  dueDate: string;
  estimateMinutes: number;
  cadence?: PlannerCadence;
  timesPerWeek?: number;
  fixedTime?: string | null;
  idSeed: number;
}): PlannerItem {
  return {
    id: input.idSeed,
    title: input.title,
    kind: input.kind,
    category: input.category,
    priority: input.priority,
    dueDate: input.dueDate,
    estimateMinutes: input.estimateMinutes,
    cadence: input.cadence ?? "once",
    timesPerWeek: input.timesPerWeek,
    fixedTime: input.fixedTime ?? null,
    completed: false
  };
}

function parsePlannerPayloadFromMessage(
  message: string,
  baseDate: Date
): { items: PlannerItem[]; suggestedBlocks: ProjectedPlanBlock[] } {
  const lines = splitTaskClauses(message);
  const items: PlannerItem[] = [];
  const suggestedBlocks: ProjectedPlanBlock[] = [];
  let idSeed = Date.now();
  let blockSeed = Date.now() + 50000;
  let latestExam: { title: string; dueDate: string } | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    const weekdayMatch = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    const dueDate = weekdayMatch ? findNextWeekday(baseDate, weekdayMatch[1]) : parseRelativeDueDate(line, baseDate);
    const hasExamKeyword = /\b(examlet|exam|quiz|test)\b/i.test(line);
    const courseMatch = line.match(/\b([A-Za-z]{2,}\s*\d{2,3})\b/i);
    const course = courseMatch ? normalizeCourseCode(courseMatch[1]) : "";
    const clock = parseClockToHourFloat(line);
    const fixedTime = clock === null ? null : fmtTime(clock);
    const hasCallKeyword = /\b(call|meeting|appointment)\b/i.test(line);
    const hasProjectKeyword = /\b(machine project|project)\b/i.test(line);
    const wantsSplit = /\b(multiple|spread out|split)\b/i.test(line);
    const isDaily = /\b(daily|every day|each day)\b/i.test(line);
    const isWeekdays = /\bevery weekday\b/i.test(line);
    const timesPerWeekMatch = lower.match(/\b([1-7])\s*times?\s*(a|per)\s*week\b/);
    const timesPerWeek = timesPerWeekMatch ? Number(timesPerWeekMatch[1]) : undefined;

    if (hasExamKeyword && weekdayMatch && clock !== null) {
      const examKeywordMatch = line.match(/\b(examlet|exam|quiz|test)\b/i);
      const examKeyword = examKeywordMatch ? examKeywordMatch[1] : "Exam";
      const examTitle = `${course ? `${course} ` : ""}${examKeyword[0].toUpperCase()}${examKeyword.slice(1)}`.trim();
      const examItem = buildPlannerItem({
        idSeed,
        title: examTitle,
        kind: "deadline",
        category: "Exams",
        priority: "High",
        dueDate,
        estimateMinutes: 90,
        fixedTime
      });
      idSeed += 1;
      items.push(examItem);
      latestExam = { title: examTitle, dueDate };
      suggestedBlocks.push({
        id: blockSeed,
        plannerItemId: examItem.id,
        title: examTitle,
        date: dueDate,
        sh: clock,
        eh: Math.min(clock + 1, 22),
        priority: "High",
        fixed: true,
        reason: "Fixed assessment time from your message."
      });
      blockSeed += 1;
    }

    if (hasCallKeyword && weekdayMatch && clock !== null) {
      const callTitleMatch = line.match(/\b(client call|call|meeting|appointment)\b/i);
      const callTitle = callTitleMatch ? callTitleMatch[1] : "Call";
      const title = course ? `${course} ${callTitle}` : callTitle;
      const callItem = buildPlannerItem({
        idSeed,
        title: title
          .split(" ")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" "),
        kind: "deadline",
        category: "General",
        priority: "High",
        dueDate,
        estimateMinutes: 60,
        fixedTime
      });
      idSeed += 1;
      items.push(callItem);
      suggestedBlocks.push({
        id: blockSeed,
        plannerItemId: callItem.id,
        title: callItem.title,
        date: dueDate,
        sh: clock,
        eh: Math.min(clock + 1, 22),
        priority: "High",
        fixed: true,
        reason: "Fixed call time from your message."
      });
      blockSeed += 1;
    }

    if (/\bstudy\b/i.test(line) && (latestExam || hasExamKeyword)) {
      const target = latestExam?.title ?? `${course} exam`;
      const targetDue = latestExam?.dueDate ?? dueDate;
      const estimate = /\ba lot\b/i.test(line) ? 180 : parseEstimateMinutes(line);
      items.push(
        buildPlannerItem({
          idSeed,
          title: `Study for ${target}`,
          kind: "todo",
          category: "Study",
          priority: "High",
          dueDate: targetDue,
          estimateMinutes: Math.max(60, estimate)
        })
      );
      idSeed += 1;
    }

    if (/\breview\b/i.test(line) && (latestExam || hasExamKeyword || /\bquiz\b/i.test(line))) {
      const quizTitle = course ? `${course} Quiz` : latestExam?.title ?? "Quiz";
      const targetDue = latestExam?.dueDate ?? dueDate;
      items.push(
        buildPlannerItem({
          idSeed,
          title: `Review for ${quizTitle}`,
          kind: "todo",
          category: "Study",
          priority: "Medium",
          dueDate: targetDue,
          estimateMinutes: 90
        })
      );
      idSeed += 1;
    }

    if (/\bhomework\b/i.test(line)) {
      const title = normalizeTaskTitle(line, course);
      const cadence: PlannerCadence = isDaily
        ? "daily"
        : isWeekdays
          ? "weekdays"
          : timesPerWeek
            ? "times_per_week"
            : "once";
      const estimate =
        /30\s*minutes?\s*to\s*an?\s*hour/i.test(lower) || /30\s*minutes?\s*to\s*1\s*hour/i.test(lower)
          ? 45
          : parseEstimateMinutes(line);
      const hwItem = buildPlannerItem({
        idSeed,
        title,
        kind: /\bdue\b|\bby\b/i.test(line) ? "deadline" : "todo",
        category: "Homework",
        priority: /\bmath\b/i.test(line) ? "High" : "Medium",
        dueDate,
        estimateMinutes: Math.max(30, estimate),
        cadence,
        timesPerWeek,
        fixedTime: /\bdue\b|\bby\b/i.test(line) ? fixedTime : null
      });
      idSeed += 1;
      items.push(hwItem);
    }

    if (hasProjectKeyword) {
      const projectTitle =
        course && /\bmachine project\b/i.test(line)
          ? `${course} Machine Project`
          : course
            ? `${course} Project`
            : "Project";
      items.push(
        buildPlannerItem({
          idSeed,
          title: projectTitle,
          kind: /\bdue\b|\bby\b/i.test(line) ? "deadline" : "todo",
          category: "Homework",
          priority: "High",
          dueDate,
          estimateMinutes: wantsSplit ? 240 : 120
        })
      );
      items[items.length - 1].splitPreferred = wantsSplit;
      idSeed += 1;
    }

    if (!hasExamKeyword && !hasCallKeyword && !/\bhomework\b/i.test(line) && !hasProjectKeyword) {
      if (isDaily || timesPerWeek || /\barc\b|\bgym\b|\bwater\b|\blesson\b/i.test(line)) {
        const normalizedTitle = normalizeTaskTitle(line, course);
        let cadence: PlannerCadence = isDaily
          ? "daily"
          : isWeekdays
            ? "weekdays"
            : timesPerWeek
              ? "times_per_week"
              : "once";
        const category: PlannerCategory = /\blesson|study|review\b/i.test(line) ? "Study" : "General";
        let estimateMinutes = parseEstimateMinutes(line);
        let chosenTime = fixedTime;
        if (/\bwater\b/i.test(line)) {
          if (cadence === "once") {
            cadence = "daily";
          }
          estimateMinutes = 15;
          chosenTime = chosenTime ?? "10:30";
        }
        if (/\barc\b|\bgym\b/i.test(line)) {
          estimateMinutes = Math.max(45, estimateMinutes);
        }
        items.push(
          buildPlannerItem({
            idSeed,
            title: normalizedTitle,
            kind: "todo",
            category,
            priority: /\bwater\b/i.test(line) ? "Low" : "Medium",
            dueDate,
            estimateMinutes,
            cadence,
            timesPerWeek,
            fixedTime: chosenTime
          })
        );
        idSeed += 1;
      }
    }
  }

  if (items.length > 0) {
    return { items: items.slice(0, 30), suggestedBlocks };
  }

  const fallbackItems = lines.map((line, index) =>
    buildPlannerItem({
      idSeed: idSeed + index,
      title: line,
      kind: /\b(due|deadline|submit|by)\b/i.test(line) ? "deadline" : "todo",
      category: "General",
      priority: parsePriority(line),
      dueDate: parseRelativeDueDate(line, baseDate),
      estimateMinutes: parseEstimateMinutes(line)
    })
  );
  return { items: fallbackItems.slice(0, 20), suggestedBlocks: [] };
}

function describeRecurrence(interval: EnergyInterval): string {
  const recurrence = interval.recurrence;
  if (recurrence.type === "daily") {
    return "Daily";
  }
  if (recurrence.type === "weekly") {
    const days = (recurrence.days_of_week ?? [])
      .map((day) => WEEKDAY_NAMES[day] ?? `${day}`)
      .join(", ");
    return days ? `Weekly (${days})` : "Weekly";
  }
  if (recurrence.type === "specific_date") {
    return recurrence.date ? `On ${recurrence.date}` : "Specific date";
  }
  if (recurrence.type === "date_range") {
    const from = recurrence.start_date ?? "?";
    const to = recurrence.end_date ?? "?";
    if ((recurrence.days_of_week ?? []).length > 0) {
      const days = (recurrence.days_of_week ?? [])
        .map((day) => WEEKDAY_NAMES[day] ?? `${day}`)
        .join(", ");
      return `${from} to ${to} (${days})`;
    }
    return `${from} to ${to}`;
  }
  if (recurrence.type === "monthly_nth_weekday") {
    const week = recurrence.week_of_month ?? "?";
    const weekday =
      recurrence.weekday !== null && recurrence.weekday !== undefined
        ? (WEEKDAY_NAMES[recurrence.weekday] ?? `${recurrence.weekday}`)
        : "?";
    return `Monthly: week ${week}, ${weekday}`;
  }
  const week = recurrence.week_of_month ?? "?";
  const days = (recurrence.days_of_week ?? [])
    .map((day) => WEEKDAY_NAMES[day] ?? `${day}`)
    .join(", ");
  return days ? `Monthly week ${week} (${days})` : `Monthly week ${week}`;
}

function describeEnergyInterval(interval: EnergyInterval): string {
  const level = interval.energy_level > 0 ? `+${interval.energy_level}` : `${interval.energy_level}`;
  const blockText = interval.hard_block ? "Hard block" : `Energy ${level}`;
  const label = interval.label?.trim() ? interval.label.trim() : interval.id;
  return `${label}: ${interval.start_time}-${interval.end_time} | ${blockText} | ${describeRecurrence(interval)}`;
}

function App() {
  const api = useMemo(() => new ApiClient(DEFAULT_API_URL), []);
  const userId = DEFAULT_USER_ID;

  const [activeTab, setActiveTab] = useState<TopTab>("calendar");
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("chat");
  const [curView, setCurView] = useState<ViewMode>("week");
  const [curDate, setCurDate] = useState<Date>(new Date(TODAY));
  const [wkStart, setWkStart] = useState<Date>(weekOf(new Date(TODAY)));
  const [mthDate, setMthDate] = useState<Date>(new Date(TODAY.getFullYear(), TODAY.getMonth(), 1));
  const [events, setEvents] = useState<EventItem[]>([]);
  const [nextId, setNextId] = useState(1);
  const [calendarReady, setCalendarReady] = useState(false);
  const [calendarSyncState, setCalendarSyncState] = useState<"loading" | "ready" | "syncing" | "error">("loading");
  const [calendarSyncMessage, setCalendarSyncMessage] = useState("Loading calendar...");
  const [backendOnline, setBackendOnline] = useState(true);
  const [energyProfile, setEnergyProfile] = useState<EnergyProfile>(EMPTY_ENERGY_PROFILE);
  const [energySaveState, setEnergySaveState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [popupSummaryMessage, setPopupSummaryMessage] = useState("Updated energy profile");

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "assistant",
      text: "Tell me your tasks for today or this week. I will organize them into an editable list with due dates, priority, and time estimates."
    }
  ]);
  const [chatEmotions, setChatEmotions] = useState<string[]>([]);
  const [isAnalyzingChat, setIsAnalyzingChat] = useState(false);
  const [plannerItems, setPlannerItems] = useState<PlannerItem[]>([]);
  const [confirmedTodoItems, setConfirmedTodoItems] = useState<PlannerItem[]>([]);
  const [projectedBlocks, setProjectedBlocks] = useState<ProjectedPlanBlock[]>([]);
  const [hoveredProjectedId, setHoveredProjectedId] = useState<number | null>(null);
  const [hoverReasonAnchor, setHoverReasonAnchor] = useState<HoverReasonAnchor | null>(null);
  const [plannerPanelOpen, setPlannerPanelOpen] = useState(false);

  const [energyTab, setEnergyTab] = useState<EnergyTab>("day");
  const [auraMode, setAuraMode] = useState(false);

  const [overlayOpen, setOverlayOpen] = useState(false);
  const [popupStep, setPopupStep] = useState<1 | 2>(1);
  const [dayInput, setDayInput] = useState("");

  const [gridAnim, setGridAnim] = useState<GridAnim>("fade");
  const [gridAnimNonce, setGridAnimNonce] = useState(0);

  const [eventPopup, setEventPopup] = useState<EventPopupState>({
    open: false,
    x: 0,
    y: 0,
    date: "",
    hour: 0,
    name: "",
    location: "",
    start: "09:00",
    end: "10:00",
    color: "dark"
  });

  const [eventEditor, setEventEditor] = useState<EventEditorState>({
    open: false,
    eventId: null,
    date: "",
    title: "",
    start: "09:00",
    end: "10:00",
    color: "dark"
  });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [suppressClickEventId, setSuppressClickEventId] = useState<number | null>(null);

  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const timeScrollRef = useRef<HTMLDivElement | null>(null);
  const eventPopupRef = useRef<HTMLDivElement | null>(null);
  const dayInputRef = useRef<HTMLTextAreaElement | null>(null);
  const calMainRef = useRef<HTMLDivElement | null>(null);
  const skipNextCalendarSyncRef = useRef(true);

  const hoveredProjectedBlock = useMemo(
    () => projectedBlocks.find((block) => block.id === hoveredProjectedId) ?? null,
    [hoveredProjectedId, projectedBlocks]
  );
  const showPlannerColumn = sidebarMode === "chat" && plannerPanelOpen;

  const periodTitle = useMemo(
    () => buildPeriodTitle(curView, wkStart, curDate, mthDate),
    [curView, wkStart, curDate, mthDate]
  );

  const dateColumns = useMemo(() => getDatesForView(curView, wkStart, curDate), [curView, wkStart, curDate]);
  const auraBlobs = useMemo(() => {
    if (curView === "month") {
      return [] as Array<{
        key: string;
        leftPct: number;
        topPx: number;
        widthPx: number;
        heightPx: number;
        color: string;
        delayMs: number;
      }>;
    }

    const cols = colsForView(curView);
    const blobs = dateColumns.flatMap((date, dateIndex) => {
      const dateStr = fmtDate(date);
      const dayEvents = events.filter((eventItem) => eventItem.date === dateStr);
      return dayEvents.map((eventItem, idx) => {
        const duration = Math.max(eventItem.eh - eventItem.sh, 0.4);
        const centerHour = eventItem.sh + duration / 2;
        const leftJitter = ((eventItem.id % 5) - 2) * (1.2 / cols);
        const leftPct = ((dateIndex + 0.5) / cols) * 100 + leftJitter * 100;
        const widthPx = Math.max(88, 150 - cols * 11) + (eventItem.id % 3) * 20;
        const heightPx = Math.max(120, duration * HOUR_H * 1.75);
        const topPx = (centerHour - START_H) * HOUR_H - heightPx * 0.5;
      const color =
        eventItem.c === "dark"
          ? "rgba(244, 154, 166, 0.52)"
          : eventItem.c === "light"
              ? "rgba(250, 210, 145, 0.48)"
            : eventItem.c === "blueLight"
                ? "rgba(177, 218, 255, 0.48)"
              : eventItem.c === "greenLight"
                  ? "rgba(187, 237, 206, 0.46)"
              : eventItem.c === "blue"
                ? "rgba(156, 198, 247, 0.50)"
                : "rgba(172, 224, 191, 0.44)";
        return {
          key: `${eventItem.id}-${idx}`,
          leftPct,
          topPx,
          widthPx,
          heightPx,
          color,
          delayMs: (eventItem.id % 6) * 240
        };
      });
    });

    const ambient = [
      {
        key: "ambient-morning",
        leftPct: 18,
        topPx: (9.5 - START_H) * HOUR_H - 120,
        widthPx: 220,
        heightPx: 180,
        color: "rgba(252, 220, 169, 0.30)",
        delayMs: 0
      },
      {
        key: "ambient-noon",
        leftPct: 56,
        topPx: (13 - START_H) * HOUR_H - 130,
        widthPx: 260,
        heightPx: 190,
        color: "rgba(246, 168, 187, 0.26)",
        delayMs: 160
      },
      {
        key: "ambient-evening",
        leftPct: 84,
        topPx: (17 - START_H) * HOUR_H - 130,
        widthPx: 240,
        heightPx: 200,
        color: "rgba(163, 196, 243, 0.28)",
        delayMs: 320
      }
    ];

    return [...ambient, ...blobs];
  }, [curView, dateColumns, events]);
  const auraSlots = useMemo(() => {
    if (curView === "month") {
      return [] as Array<{ hour: number; topPx: number; color: string; opacity: number }>;
    }
    return Array.from({ length: 22 - START_H + 1 }, (_, idx) => {
      const hour = START_H + idx;
      const palette =
        idx % 3 === 0
          ? "rgba(245, 148, 166, 0.24)"
          : idx % 3 === 1
            ? "rgba(250, 205, 132, 0.23)"
            : "rgba(153, 193, 245, 0.24)";
      const stronger =
        idx % 4 === 0
          ? 0.32
          : idx % 4 === 2
            ? 0.28
            : 0.24;
      return {
        hour,
        topPx: idx * HOUR_H,
        color: palette,
        opacity: stronger
      };
    });
  }, [curView]);
  const auraHalosByDate = useMemo(() => {
    const map: Record<
      string,
      Array<{ key: string; top: number; height: number; color: string }>
    > = {};
    for (const eventItem of events) {
      const top = (eventItem.sh - START_H) * HOUR_H - 10;
      const height = Math.max((eventItem.eh - eventItem.sh) * HOUR_H + 20, 40);
      const color =
        eventItem.c === "dark"
          ? "rgba(244, 154, 166, 0.44)"
          : eventItem.c === "light"
            ? "rgba(250, 210, 145, 0.4)"
            : eventItem.c === "blueLight"
                ? "rgba(177, 218, 255, 0.40)"
              : eventItem.c === "greenLight"
                  ? "rgba(187, 237, 206, 0.38)"
            : eventItem.c === "blue"
              ? "rgba(156, 198, 247, 0.42)"
              : "rgba(172, 224, 191, 0.38)";
      if (!map[eventItem.date]) {
        map[eventItem.date] = [];
      }
      map[eventItem.date].push({
        key: `halo-${eventItem.id}`,
        top,
        height,
        color
      });
    }
    return map;
  }, [events]);

  function applyHydratedState(state: UserState) {
    const mappedEvents = mapBackendEventsToUiEvents(state.calendar_events ?? []);
    skipNextCalendarSyncRef.current = true;
    setEvents(mappedEvents);
    setNextId(mappedEvents.reduce((maxId, item) => Math.max(maxId, item.id), 0) + 1);
    const linkedTodoGroups = new Map<number, EventItem[]>();
    for (const eventItem of mappedEvents) {
      if (!isTodoColor(eventItem.c) || eventItem.sourcePlannerItemId === undefined) {
        continue;
      }
      const existing = linkedTodoGroups.get(eventItem.sourcePlannerItemId) ?? [];
      existing.push(eventItem);
      linkedTodoGroups.set(eventItem.sourcePlannerItemId, existing);
    }
    const rebuiltTodos = [...linkedTodoGroups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([plannerId, linkedEvents]) => inferTodoItemFromEvents(plannerId, linkedEvents));
    setConfirmedTodoItems(rebuiltTodos);
    setEnergyProfile(state.energy_profile ?? EMPTY_ENERGY_PROFILE);

    if (mappedEvents.length > 0) {
      const firstDate = parseDateKey(mappedEvents[0].date);
      if (firstDate) {
        setCurDate(firstDate);
        setWkStart(weekOf(firstDate));
        setMthDate(new Date(firstDate.getFullYear(), firstDate.getMonth(), 1));
      }
    }
  }

  async function refreshCalendarFromBackend() {
    setCalendarSyncState("loading");
    setCalendarSyncMessage("Loading calendar...");
    try {
      const state = await api.getUserState(userId);
      applyHydratedState(state);
      const mappedEvents = mapBackendEventsToUiEvents(state.calendar_events ?? []);
      setBackendOnline(true);
      setCalendarSyncState("ready");
      setCalendarSyncMessage(
        `Loaded ${mappedEvents.length} event${mappedEvents.length === 1 ? "" : "s"} from backend.`
      );
    } catch (error) {
      setBackendOnline(false);
      setCalendarSyncState("ready");
      setCalendarSyncMessage(`Backend unavailable, running in local mode (${getErrorMessage(error)}).`);
    } finally {
      setCalendarReady(true);
    }
  }

  async function syncCalendarToBackend(nextEvents: EventItem[]) {
    if (!backendOnline) {
      return;
    }
    try {
      setCalendarSyncState("syncing");
      setCalendarSyncMessage("Saving calendar...");
      const payload = mapUiEventsToBackendEvents(nextEvents);
      await api.syncCalendar(userId, payload);
      setBackendOnline(true);
      setCalendarSyncState("ready");
      setCalendarSyncMessage(`Synced ${payload.length} event${payload.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setBackendOnline(false);
      setCalendarSyncState("ready");
      setCalendarSyncMessage(`Backend sync paused. Local changes are kept (${getErrorMessage(error)}).`);
    }
  }

  useEffect(() => {
    void refreshCalendarFromBackend();
  }, [api]);

  useEffect(() => {
    if (!calendarReady || !backendOnline) {
      return;
    }
    if (skipNextCalendarSyncRef.current) {
      skipNextCalendarSyncRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void syncCalendarToBackend(events);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [calendarReady, events]);

  useEffect(() => {
    if (!timeScrollRef.current || curView === "month") {
      return;
    }
    timeScrollRef.current.scrollTop = (9 - START_H) * HOUR_H - 10;
  }, [curView, wkStart, curDate, gridAnimNonce]);

  useEffect(() => {
    if (!overlayOpen || !dayInputRef.current) {
      return;
    }
    const timer = window.setTimeout(() => dayInputRef.current?.focus(), 250);
    return () => window.clearTimeout(timer);
  }, [overlayOpen]);

  useEffect(() => {
    if (!chatAreaRef.current) {
      return;
    }
    chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
  }, [chatMessages]);

  useEffect(() => {
    setConfirmedTodoItems((current) =>
      current.map((item) => {
        const linkedTodoEvents = events.filter(
          (eventItem) => eventItem.sourcePlannerItemId === item.id && isTodoColor(eventItem.c)
        );
        if (linkedTodoEvents.length === 0) {
          return item;
        }
        const completed = linkedTodoEvents.every((eventItem) => eventItem.done);
        if (completed === item.completed) {
          return item;
        }
        return { ...item, completed };
      })
    );
  }, [events]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOverlayOpen(false);
        setEventPopup((current) => ({ ...current, open: false }));
        setEventEditor((current) => ({ ...current, open: false }));
      }
    };

    const onDocumentClick = (event: MouseEvent) => {
      if (!eventPopup.open) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (eventPopupRef.current?.contains(target)) {
        return;
      }
      if (target.closest(".h-cell")) {
        return;
      }
      setEventPopup((current) => ({ ...current, open: false }));
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onDocumentClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onDocumentClick);
    };
  }, [eventPopup.open]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const minHour = START_H;
    const maxHour = 22;
    const minDuration = 0.25;
    const baseDuration = dragState.startEh - dragState.startSh;

    const onMove = (event: MouseEvent) => {
      event.preventDefault();
      const didMove = Math.abs(event.clientY - dragState.startY) > 2;
      if (didMove && !dragState.moved && dragState.target === "event") {
        setSuppressClickEventId(dragState.itemId);
        setDragState((current) => (current ? { ...current, moved: true } : current));
      }
      const deltaHours = snapQuarter((event.clientY - dragState.startY) / HOUR_H);

      const nextDate = (() => {
        const el = document.elementFromPoint(event.clientX, event.clientY);
        const target = el?.closest(".day-col[data-date]") as HTMLElement | null;
        return target?.dataset.date ?? dragState.startDate;
      })();
      if (dragState.target === "event") {
        setEvents((current) =>
          current.map((item) => {
            if (item.id !== dragState.itemId) {
              return item;
            }

            if (dragState.mode === "move") {
              let sh = dragState.startSh + deltaHours;
              let eh = sh + baseDuration;
              if (sh < minHour) {
                sh = minHour;
                eh = sh + baseDuration;
              }
              if (eh > maxHour) {
                eh = maxHour;
                sh = eh - baseDuration;
              }
              return { ...item, date: nextDate, sh, eh };
            }

            if (dragState.mode === "resize-start") {
              const maxStart = dragState.startEh - minDuration;
              const sh = Math.max(minHour, Math.min(dragState.startSh + deltaHours, maxStart));
              return { ...item, sh };
            }

            const minEnd = dragState.startSh + minDuration;
            const eh = Math.min(maxHour, Math.max(dragState.startEh + deltaHours, minEnd));
            return { ...item, eh };
          })
        );
        return;
      }

      setProjectedBlocks((current) =>
        current.map((block) => {
          if (block.id !== dragState.itemId) {
            return block;
          }
          let sh = dragState.startSh + deltaHours;
          let eh = dragState.startEh + deltaHours;
          const duration = Math.max(block.eh - block.sh, 0.25);
          if (sh < minHour) {
            sh = minHour;
            eh = sh + duration;
          }
          if (eh > maxHour) {
            eh = maxHour;
            sh = eh - duration;
          }
          return { ...block, date: nextDate, sh, eh };
        })
      );
    };

    const onUp = () => {
      setDragState(null);
      window.setTimeout(() => setSuppressClickEventId(null), 0);
    };

    document.body.classList.add("event-dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.classList.remove("event-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragState]);

  function triggerGridAnimation(next: GridAnim) {
    setGridAnim(next);
    setGridAnimNonce((current) => current + 1);
  }

  function navPrev() {
    triggerGridAnimation("prev");
    if (curView === "week") {
      const next = new Date(wkStart);
      next.setDate(next.getDate() - 7);
      setWkStart(next);
      return;
    }
    if (curView === "day") {
      const next = new Date(curDate);
      next.setDate(next.getDate() - 1);
      setCurDate(next);
      return;
    }
    if (curView === "3days") {
      const next = new Date(curDate);
      next.setDate(next.getDate() - 3);
      setCurDate(next);
      return;
    }
    const nextMonth = new Date(mthDate);
    nextMonth.setMonth(nextMonth.getMonth() - 1);
    setMthDate(nextMonth);
  }

  function navNext() {
    triggerGridAnimation("next");
    if (curView === "week") {
      const next = new Date(wkStart);
      next.setDate(next.getDate() + 7);
      setWkStart(next);
      return;
    }
    if (curView === "day") {
      const next = new Date(curDate);
      next.setDate(next.getDate() + 1);
      setCurDate(next);
      return;
    }
    if (curView === "3days") {
      const next = new Date(curDate);
      next.setDate(next.getDate() + 3);
      setCurDate(next);
      return;
    }
    const nextMonth = new Date(mthDate);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    setMthDate(nextMonth);
  }

  function handleViewChange(nextView: ViewMode) {
    triggerGridAnimation("fade");
    setCurView(nextView);
  }

  function openAuraPopup() {
    setPopupStep(1);
    setDayInput("");
    setPopupSummaryMessage("Updated energy profile");
    setEnergySaveState("idle");
    setOverlayOpen(true);
  }

  function closePopup() {
    setOverlayOpen(false);
    setPopupStep(1);
    setDayInput("");
    setPopupSummaryMessage("Updated energy profile");
    setEnergySaveState("idle");
  }

  async function submitDay() {
    const description = dayInput.trim();
    if (!description || energySaveState === "saving") {
      return;
    }
    const previousProfile = energyProfile;
    setEnergySaveState("saving");
    setPopupSummaryMessage("Updating energy profile...");
    setPopupStep(2);
    try {
      await api.updateEnergyProfile(userId, description);
      const state = await api.getUserState(userId);
      applyHydratedState(state);
      setEnergySaveState("success");
      setPopupSummaryMessage(
        summarizeEnergyProfileUpdate(previousProfile, state.energy_profile ?? EMPTY_ENERGY_PROFILE, description)
      );
    } catch {
      setEnergySaveState("error");
      setPopupSummaryMessage("Unable to update energy profile");
    }
  }

  function saveInsights() {
    closePopup();
  }

  function handleCellClick(event: ReactMouseEvent<HTMLDivElement>, date: string, hour: number) {
    const x = Math.min(event.clientX, window.innerWidth - 290);
    const y = Math.min(event.clientY - 20, window.innerHeight - 260);
    setEventPopup({
      open: true,
      x,
      y,
      date,
      hour,
      name: "",
      location: "",
      start: fmtTime(hour),
      end: fmtTime(hour + 1),
      color: "dark"
    });
  }

  function closeEventPopup() {
    setEventPopup((current) => ({ ...current, open: false }));
  }

  function saveEvent() {
    const name = eventPopup.name.trim();
    if (!name) {
      return;
    }
    const sh = parseTime(eventPopup.start);
    const eh = parseTime(eventPopup.end);
    if (Number.isNaN(sh) || Number.isNaN(eh)) {
      return;
    }
    const nextEvent: EventItem = {
      id: nextId,
      backendId: `calendar_${Date.now()}_${nextId}`,
      date: eventPopup.date,
      sh,
      eh: Math.max(eh, sh + 0.25),
      title: name,
      c: eventPopup.color,
      done: false
    };
    setEvents((current) => [...current, nextEvent]);
    setNextId((current) => current + 1);
    setEventPopup((current) => ({ ...current, open: false }));
  }

  function toggleEventDone(eventId: number) {
    setEvents((current) =>
      current.map((item) => {
        if (item.id !== eventId || !isTodoColor(item.c)) {
          return item;
        }
        return { ...item, done: !item.done };
      })
    );
  }

  function startEventDrag(event: ReactMouseEvent<HTMLDivElement | HTMLButtonElement>, eventItem: EventItem, mode: DragMode) {
    event.preventDefault();
    event.stopPropagation();
    setDragState({
      target: "event",
      itemId: eventItem.id,
      mode,
      startY: event.clientY,
      startSh: eventItem.sh,
      startEh: eventItem.eh,
      startDate: eventItem.date,
      moved: false
    });
  }

  function startProjectedBlockDrag(event: ReactMouseEvent<HTMLDivElement>, block: ProjectedPlanBlock) {
    event.preventDefault();
    event.stopPropagation();
    setDragState({
      target: "projected",
      itemId: block.id,
      mode: "move",
      startY: event.clientY,
      startSh: block.sh,
      startEh: block.eh,
      startDate: block.date,
      moved: false
    });
  }

  function openEventEditor(eventItem: EventItem) {
    setEventEditor({
      open: true,
      eventId: eventItem.id,
      date: eventItem.date,
      title: eventItem.title,
      start: fmtTime(eventItem.sh),
      end: fmtTime(eventItem.eh),
      color: eventItem.c
    });
  }

  function saveEditedEvent() {
    if (eventEditor.eventId === null) {
      return;
    }
    const title = eventEditor.title.trim();
    if (!title) {
      return;
    }
    const sh = parseTime(eventEditor.start);
    const eh = parseTime(eventEditor.end);
    if (Number.isNaN(sh) || Number.isNaN(eh)) {
      return;
    }

    setEvents((current) =>
      current.map((item) => {
        if (item.id !== eventEditor.eventId) {
          return item;
        }
        return {
          ...item,
          title,
          sh,
          eh: Math.max(eh, sh + 0.25),
          c: eventEditor.color
        };
      })
    );
    setEventEditor((current) => ({ ...current, open: false }));
  }

  function deleteEditedEvent() {
    if (eventEditor.eventId === null) {
      return;
    }
    setEvents((current) => current.filter((item) => item.id !== eventEditor.eventId));
    setEventEditor((current) => ({ ...current, open: false }));
  }

  function updatePlannerItem(itemId: number, changes: Partial<PlannerItem>) {
    setPlannerItems((current) =>
      current.map((item) => {
        if (item.id !== itemId) {
          return item;
        }
        return { ...item, ...changes };
      })
    );
  }

  function removePlannerItem(itemId: number) {
    setPlannerItems((current) => current.filter((item) => item.id !== itemId));
  }

  function updateConfirmedTodoItem(itemId: number, changes: Partial<PlannerItem>) {
    setConfirmedTodoItems((current) =>
      current.map((item) => (item.id === itemId ? { ...item, ...changes } : item))
    );
    if (changes.title !== undefined) {
      const nextTitle = changes.title.trim();
      if (nextTitle) {
        setEvents((current) =>
          current.map((eventItem) =>
            eventItem.sourcePlannerItemId === itemId
              ? { ...eventItem, title: withPreservedSuffix(eventItem.title, nextTitle) }
              : eventItem
          )
        );
      }
    }
  }

  function toggleConfirmedTodoDone(itemId: number) {
    let nextDone = false;
    setConfirmedTodoItems((current) =>
      current.map((item) => {
        if (item.id !== itemId) {
          return item;
        }
        nextDone = !item.completed;
        return { ...item, completed: nextDone };
      })
    );
    setEvents((current) =>
      current.map((eventItem) =>
        eventItem.sourcePlannerItemId === itemId && isTodoColor(eventItem.c)
          ? { ...eventItem, done: nextDone }
          : eventItem
      )
    );
  }

  function removeConfirmedTodoItem(itemId: number) {
    setConfirmedTodoItems((current) => current.filter((item) => item.id !== itemId));
    setEvents((current) => current.filter((eventItem) => eventItem.sourcePlannerItemId !== itemId));
  }

  function regenerateScheduleFromTodos() {
    if (confirmedTodoItems.length === 0) {
      return;
    }
    const resetItems = confirmedTodoItems.map((item) => ({ ...item, completed: false }));
    const todoIds = new Set(resetItems.map((item) => item.id));
    setEvents((current) => current.filter((eventItem) => !todoIds.has(eventItem.sourcePlannerItemId ?? -1)));
    setPlannerItems(resetItems);
    setProjectedBlocks([]);
    setHoveredProjectedId(null);
    setHoverReasonAnchor(null);
    setSidebarMode("chat");
    setPlannerPanelOpen(true);
    setChatMessages((current) => [
      ...current,
      {
        id: Date.now(),
        role: "assistant",
        text: "Loaded your edited to-do list back into Weekly Task List. Click Generate Plan to create a refreshed schedule."
      }
    ]);
  }

  function priorityScore(priority: PriorityTag): number {
    if (priority === "High") {
      return 0;
    }
    if (priority === "Medium") {
      return 1;
    }
    return 2;
  }

  function findOpenSlot(
    occupied: Array<{ sh: number; eh: number }>,
    preferredStarts: number[],
    durationHours: number
  ): { sh: number; eh: number } | null {
    for (const startHour of preferredStarts) {
      const sh = startHour;
      const eh = Math.min(22, sh + durationHours);
      const hasOverlap = occupied.some((slot) => sh < slot.eh && eh > slot.sh);
      if (!hasOverlap && eh - sh >= 0.5) {
        return { sh, eh };
      }
    }
    return null;
  }

  function generateProjectedPlan() {
    const activeItems = plannerItems.filter((item) => !item.completed && item.title.trim().length > 0);
    if (activeItems.length === 0) {
      setChatMessages((current) => [
        ...current,
        {
          id: Date.now(),
          role: "assistant",
          text: "I need at least one active task before I can build your plan."
        }
      ]);
      return;
    }
    const weekStart = weekOf(new Date(curDate));
    const busyByDate = new Map<string, Array<{ sh: number; eh: number }>>();
    for (const eventItem of events) {
      const day = busyByDate.get(eventItem.date) ?? [];
      day.push({ sh: eventItem.sh, eh: eventItem.eh });
      busyByDate.set(eventItem.date, day);
    }

    const sorted = [...activeItems].sort((a, b) => {
      const examDelta = (a.category === "Exams" ? -1 : 0) - (b.category === "Exams" ? -1 : 0);
      if (examDelta !== 0) {
        return examDelta;
      }
      const priorityDelta = priorityScore(a.priority) - priorityScore(b.priority);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return a.dueDate.localeCompare(b.dueDate);
    });

    const newBlocks: ProjectedPlanBlock[] = [];
    let blockIdSeed = Date.now();
    for (const item of sorted) {
      if (item.fixedTime && item.cadence === "once") {
        const sh = parseTime(item.fixedTime);
        newBlocks.push({
          id: blockIdSeed,
          plannerItemId: item.id,
          title: item.title,
          date: item.dueDate,
          sh,
          eh: Math.min(sh + Math.max(0.5, item.estimateMinutes / 60), 22),
          priority: item.priority,
          reason: "Fixed event time based on your message.",
          fixed: true
        });
        blockIdSeed += 1;
        continue;
      }

      if (item.splitPreferred) {
        let remaining = Math.max(90, item.estimateMinutes);
        let part = 1;
        const chunkMinutes = 90;
        for (let dayOffset = 0; dayOffset < 7 && remaining > 0; dayOffset += 1) {
          const date = new Date(weekStart);
          date.setDate(weekStart.getDate() + dayOffset);
          const maxDate = parseDateKey(item.dueDate);
          if (maxDate && date > maxDate) {
            break;
          }
          const dateKey = fmtDate(date);
          const occupied = [...(busyByDate.get(dateKey) ?? []), ...newBlocks.filter((b) => b.date === dateKey)];
          const slot = findOpenSlot(occupied, [9, 11, 14, 16], Math.max(0.5, Math.min(chunkMinutes, remaining) / 60));
          if (!slot) {
            continue;
          }
          newBlocks.push({
            id: blockIdSeed,
            plannerItemId: item.id,
            title: `${item.title} (Part ${part})`,
            date: dateKey,
            sh: slot.sh,
            eh: slot.eh,
            priority: item.priority,
            reason: "Split into multiple blocks for better progress and lower overload.",
            fixed: false
          });
          blockIdSeed += 1;
          part += 1;
          remaining -= chunkMinutes;
        }
        continue;
      }

      if (item.cadence === "weekdays") {
        for (let dayOffset = 0; dayOffset < 5; dayOffset += 1) {
          const date = new Date(weekStart);
          date.setDate(weekStart.getDate() + dayOffset);
          const dateKey = fmtDate(date);
          const occupied = [...(busyByDate.get(dateKey) ?? []), ...newBlocks.filter((b) => b.date === dateKey)];
          const preferred = item.fixedTime ? [parseTime(item.fixedTime)] : [17, 18, 16, 19];
          const slot = findOpenSlot(occupied, preferred, Math.max(0.5, item.estimateMinutes / 60));
          if (!slot) {
            continue;
          }
          newBlocks.push({
            id: blockIdSeed,
            plannerItemId: item.id,
            title: `${item.title} (${WEEKDAY_NAMES[dayOffset]})`,
            date: dateKey,
            sh: slot.sh,
            eh: slot.eh,
            priority: item.priority,
            reason: "Recurring weekday task placed in consistent after-class windows.",
            fixed: false
          });
          blockIdSeed += 1;
        }
        continue;
      }

      if (item.cadence === "daily") {
        for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
          const date = new Date(weekStart);
          date.setDate(weekStart.getDate() + dayOffset);
          const dateKey = fmtDate(date);
          const occupied = [...(busyByDate.get(dateKey) ?? []), ...newBlocks.filter((b) => b.date === dateKey)];
          const preferred =
            item.fixedTime
              ? [parseTime(item.fixedTime)]
              : /\bwater\b/i.test(item.title)
                ? [10.5, 15, 19]
                : [18, 17, 8];
          const slot = findOpenSlot(occupied, preferred, Math.max(0.25, item.estimateMinutes / 60));
          if (!slot) {
            continue;
          }
          newBlocks.push({
            id: blockIdSeed,
            plannerItemId: item.id,
            title: `${item.title} (${WEEKDAY_NAMES[dayOffset]})`,
            date: dateKey,
            sh: slot.sh,
            eh: slot.eh,
            priority: item.priority,
            reason: "Daily recurring task distributed across each day.",
            fixed: false
          });
          blockIdSeed += 1;
        }
        continue;
      }

      if (item.cadence === "times_per_week") {
        const targetCount = Math.min(Math.max(item.timesPerWeek ?? 1, 1), 7);
        const spreadIndexes = Array.from({ length: targetCount }, (_, idx) =>
          Math.round((idx * 6) / Math.max(targetCount - 1, 1))
        );
        const uniqueDays = [...new Set(spreadIndexes)];
        for (const dayOffset of uniqueDays) {
          const date = new Date(weekStart);
          date.setDate(weekStart.getDate() + dayOffset);
          const dateKey = fmtDate(date);
          const occupied = [...(busyByDate.get(dateKey) ?? []), ...newBlocks.filter((b) => b.date === dateKey)];
          const preferred = item.fixedTime ? [parseTime(item.fixedTime)] : [7, 8, 17, 18];
          const slot = findOpenSlot(occupied, preferred, Math.max(0.5, item.estimateMinutes / 60));
          if (!slot) {
            continue;
          }
          newBlocks.push({
            id: blockIdSeed,
            plannerItemId: item.id,
            title: `${item.title} (${WEEKDAY_NAMES[dayOffset]})`,
            date: dateKey,
            sh: slot.sh,
            eh: slot.eh,
            priority: item.priority,
            reason: `${targetCount}x weekly routine spaced across the week for consistency.`,
            fixed: false
          });
          blockIdSeed += 1;
        }
        continue;
      }

      const maxDate = parseDateKey(item.dueDate) ?? new Date(weekStart);
      const durationHours = Math.max(0.5, Math.round((item.estimateMinutes / 60) * 4) / 4);
      const preferredStarts =
        item.category === "Study"
          ? [9, 10, 13, 15]
          : item.priority === "High"
          ? [9, 10, 11, 14]
          : item.priority === "Medium"
            ? [11, 13, 15]
            : [16, 17, 10];
      let placed = false;
      for (let dayOffset = 0; dayOffset < 7 && !placed; dayOffset += 1) {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + dayOffset);
        if (date > maxDate) {
          break;
        }
        const dateKey = fmtDate(date);
        const occupied = [...(busyByDate.get(dateKey) ?? []), ...newBlocks.filter((b) => b.date === dateKey)];
        const slot = findOpenSlot(occupied, preferredStarts, durationHours);
        if (slot) {
          const reasonBase =
            item.category === "Study"
              ? "Review/study block placed before the assessment to maximize retention."
              : item.priority === "High"
                ? "High priority item placed in a peak-focus window."
              : item.priority === "Medium"
                ? "Balanced priority slotted in a steady midday window."
                : "Lower priority item placed in a lighter-energy window.";
          const reason =
            dateKey === item.dueDate
              ? `${reasonBase} Scheduled on deadline date to avoid spillover.`
              : `${reasonBase} Scheduled before the ${item.dueDate} deadline for buffer time.`;
          newBlocks.push({
            id: blockIdSeed,
            plannerItemId: item.id,
            title: item.title,
            date: dateKey,
            sh: slot.sh,
            eh: slot.eh,
            priority: item.priority,
            reason,
            fixed: false
          });
          blockIdSeed += 1;
          placed = true;
        }
      }
    }
    setProjectedBlocks(newBlocks);
    setHoveredProjectedId(null);
    setHoverReasonAnchor(null);
    setChatMessages((current) => [
      ...current,
      {
        id: Date.now(),
        role: "assistant",
        text: `I mapped out ${newBlocks.length} draft block${newBlocks.length === 1 ? "" : "s"}. Tweak anything you want, then confirm to add them to your calendar.`
      }
    ]);
  }

  function confirmProjectedPlan() {
    if (projectedBlocks.length === 0) {
      return;
    }
    const plannerById = new Map(plannerItems.map((item) => [item.id, item]));
    const nextEvents: EventItem[] = projectedBlocks.map((block, index) => ({
      id: nextId + index,
      backendId: `calendar_plan_${Date.now()}_${block.id}`,
      sourcePlannerItemId: block.plannerItemId,
      date: block.date,
      sh: block.sh,
      eh: block.eh,
      title: block.title,
      c: colorForConfirmedBlock(block, plannerById.get(block.plannerItemId)),
      done: false
    }));
    setEvents((current) => [...current, ...nextEvents]);
    setNextId((current) => current + nextEvents.length);
    setConfirmedTodoItems((current) => [
      ...current,
      ...plannerItems.filter((item) => !item.completed)
    ]);
    setPlannerItems([]);
    setProjectedBlocks([]);
    setHoveredProjectedId(null);
    setHoverReasonAnchor(null);
    setPlannerPanelOpen(false);
    setSidebarMode("todo");
    setChatMessages((current) => [
      ...current,
      {
        id: Date.now(),
        role: "assistant",
        text: "Great, your plan is confirmed. I moved everything into your To-Do List tab."
      }
    ]);
  }

  function discardProjectedPlan() {
    setProjectedBlocks([]);
    setHoveredProjectedId(null);
    setHoverReasonAnchor(null);
    setChatMessages((current) => [
      ...current,
      {
        id: Date.now(),
        role: "assistant",
        text: "Cleared projected blocks. Share updated tasks and I can draft another plan."
      }
    ]);
  }

  async function sendChat() {
    const message = chatInput.trim();
    if (!message || isAnalyzingChat) {
      return;
    }
    const userMessageId = Date.now();
    setChatMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", text: message }
    ]);
    setChatInput("");
    setIsAnalyzingChat(true);
    const parsedPayload = parsePlannerPayloadFromMessage(message, curDate);
    const parsedItems = parsedPayload.items;
    const fixedBlocks = parsedPayload.suggestedBlocks;
    const detected: string[] = [];
    if (/\b(stress|overwhelm|anxious)\b/i.test(message)) {
      detected.push("stressed");
    }
    if (/\b(excited|motivated|great)\b/i.test(message)) {
      detected.push("motivated");
    }
    if (/\b(tired|exhausted|drained)\b/i.test(message)) {
      detected.push("tired");
    }
    setChatEmotions(detected);
    if (parsedItems.length === 0) {
      setChatMessages((current) => [
        ...current,
        {
          id: userMessageId + 1,
          role: "assistant",
          text: "I couldn’t find clear tasks in that message yet. Try short lines like: 'Submit biology draft by Friday, high priority, 2h'."
        }
      ]);
      setIsAnalyzingChat(false);
      return;
    }
    setPlannerItems((current) => [...current, ...parsedItems]);
    if (fixedBlocks.length > 0) {
      setProjectedBlocks((current) => [...current, ...fixedBlocks]);
    }
    setSidebarMode("chat");
    setPlannerPanelOpen(true);
    setChatMessages((current) => [
      ...current,
      {
        id: userMessageId + 1,
        role: "assistant",
        text: `Found ${parsedItems.length} task${parsedItems.length === 1 ? "" : "s"} (${parsedItems.filter((item) => item.category === "Exams").length} exam${parsedItems.filter((item) => item.category === "Exams").length === 1 ? "" : "s"}). I added them to your list. Edit anything you want, then click Generate Plan.`
      }
    ]);
    setIsAnalyzingChat(false);
  }

  function onChatKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendChat();
    }
  }

  const monthCells = useMemo(() => {
    if (curView !== "month") {
      return [] as Array<{ date: Date; dim: boolean }>;
    }
    const year = mthDate.getFullYear();
    const month = mthDate.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const offset = firstDow === 0 ? 6 : firstDow - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const cells: Array<{ date: Date; dim: boolean }> = [];
    for (let i = 0; i < offset; i += 1) {
      cells.push({
        date: new Date(year, month - 1, prevMonthDays - offset + 1 + i),
        dim: true
      });
    }
    for (let i = 1; i <= daysInMonth; i += 1) {
      cells.push({ date: new Date(year, month, i), dim: false });
    }
    const total = offset + daysInMonth;
    const rows = Math.ceil(total / 7);
    for (let i = 1; i <= rows * 7 - total; i += 1) {
      cells.push({ date: new Date(year, month + 1, i), dim: true });
    }
    return cells;
  }, [curView, mthDate]);

  const popupToday = new Date();
  const popupDateKey = fmtDate(popupToday);
  const popupDayTitle = popupToday.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric"
  });
  const popupDayEvents = useMemo(
    () =>
      events
        .filter((eventItem) => eventItem.date === popupDateKey)
        .sort((a, b) => a.sh - b.sh),
    [events, popupDateKey]
  );
  const popupHours = useMemo(
    () => Array.from({ length: POPUP_END_H - POPUP_START_H + 1 }, (_, idx) => POPUP_START_H + idx),
    []
  );
  const totalScheduleHeight = (POPUP_END_H - POPUP_START_H) * POPUP_HOUR_H;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <svg
        width="0"
        height="0"
        style={{ position: "fixed", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
        aria-hidden="true"
        focusable="false"
      >
        <filter id="aura-displace">
          <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="8" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="16" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>

      <header className="topbar">
        <button className="hamburger" type="button" aria-label="Open menu">
          <span />
          <span />
          <span />
        </button>
        <div className="brand">
          <div className="aura-sphere brand-circle" />
          <span className="brand-name">AURA</span>
        </div>
        <nav className="topbar-tabs">
          <button
            type="button"
            className={`tab-link ${activeTab === "calendar" ? "active" : ""}`}
            onClick={() => setActiveTab("calendar")}
          >
            Calendar
          </button>
          <button
            type="button"
            className={`tab-link ${activeTab === "insights" ? "active" : ""}`}
            onClick={() => setActiveTab("insights")}
          >
            Insights
          </button>
        </nav>
      </header>

      <div className={`body-wrap ${activeTab === "calendar" ? "" : "hidden"}`} id="view-calendar">
        <aside className="sidebar">
          <div className="todo-bar">
            <span className="todo-mode-label">{sidebarMode === "chat" ? "Chat" : "To-Do List"}</span>
            <span className="todo-chevron">▾</span>
            <select
              className="todo-select"
              value={sidebarMode}
              onChange={(event) => {
                const nextMode = event.target.value as SidebarMode;
                setSidebarMode(nextMode);
                if (nextMode !== "chat") {
                  setPlannerPanelOpen(false);
                } else if (plannerItems.length > 0) {
                  setPlannerPanelOpen(true);
                }
              }}
              aria-label="Sidebar mode"
            >
              <option value="todo">To-Do List</option>
              <option value="chat">Chat</option>
            </select>
          </div>
          <div
            style={{
              margin: "8px 12px 12px",
              padding: "8px 10px",
              borderRadius: "10px",
              background: "rgba(255, 255, 255, 0.68)",
              border: "1px solid rgba(0, 0, 0, 0.07)"
            }}
          >
            <div
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: backendOnline ? "#4E4A67" : "#9E5F12"
              }}
            >
              {calendarSyncState === "loading"
                ? "Connecting backend..."
                : calendarSyncState === "syncing"
                  ? "Saving calendar..."
                  : backendOnline
                    ? "Backend connected"
                    : "Local mode (offline)"}
            </div>
            <div
              style={{
                marginTop: "4px",
                fontSize: "11px",
                color: "rgba(68, 62, 96, 0.82)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis"
              }}
              title={calendarSyncMessage}
            >
              {calendarSyncMessage}
            </div>
            <button
              type="button"
              style={{
                marginTop: "6px",
                border: "none",
                background: "transparent",
                color: "#5F5AA4",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                padding: 0
              }}
              onClick={() => {
                void refreshCalendarFromBackend();
              }}
            >
              Reload from backend
            </button>
          </div>

          {sidebarMode === "chat" ? (
            <>
              <div className="chat-area" ref={chatAreaRef}>
                {chatMessages.map((message) => (
                  <div
                    key={message.id}
                    className={message.role === "assistant" ? "chat-msg-ai" : "chat-msg-user"}
                  >
                    {message.text}
                  </div>
                ))}
                {isAnalyzingChat ? (
                  <div className="chat-msg-ai">Organizing your task list...</div>
                ) : null}
              </div>
              {chatEmotions.length > 0 ? (
                <div
                  style={{
                    margin: "0 14px 8px",
                    fontSize: "11px",
                    color: "#736f92"
                  }}
                >
                  Detected emotions: {chatEmotions.join(", ")}
                </div>
              ) : null}
              <div className="chat-input-box">
                <textarea
                  className="chat-textarea"
                  placeholder="Type your message..."
                  rows={2}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={onChatKeyDown}
                />
                <div className="chat-input-btns">
                  <button className="chat-btn chat-mic" type="button">🎤</button>
                  <button
                    className="chat-btn chat-send aura-sphere"
                    type="button"
                    onClick={() => {
                      void sendChat();
                    }}
                    disabled={chatInput.trim().length === 0 || isAnalyzingChat}
                    aria-label="Send chat message"
                    title="Send chat message"
                  >
                    ↑
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="todo-list-wrap">
              {confirmedTodoItems.length === 0 ? (
                <div className="todo-item">Confirm a generated plan to populate this list.</div>
              ) : (
                <>
                  {confirmedTodoItems.map((item) => (
                    <div key={`todo-${item.id}`} className="todo-item todo-edit-item">
                      <div className="todo-edit-top">
                        <button
                          type="button"
                          className={`planner-check ${item.completed ? "done" : ""}`}
                          onClick={() => toggleConfirmedTodoDone(item.id)}
                          aria-label={item.completed ? "Mark active" : "Mark done"}
                        >
                          {item.completed ? "✓" : ""}
                        </button>
                        <input
                          className="todo-edit-title"
                          value={item.title}
                          onChange={(event) => updateConfirmedTodoItem(item.id, { title: event.target.value })}
                        />
                        <button
                          type="button"
                          className="planner-delete"
                          onClick={() => removeConfirmedTodoItem(item.id)}
                          aria-label="Delete to-do"
                        >
                          ×
                        </button>
                      </div>
                      <div className="todo-edit-meta">
                        <span className="planner-chip planner-category">{item.category}</span>
                        <select
                          className={`planner-chip planner-priority ${item.priority.toLowerCase()}`}
                          value={item.priority}
                          onChange={(event) =>
                            updateConfirmedTodoItem(item.id, { priority: event.target.value as PriorityTag })
                          }
                          aria-label="Priority"
                        >
                          <option value="High">High</option>
                          <option value="Medium">Medium</option>
                          <option value="Low">Low</option>
                        </select>
                        <input
                          className="planner-date"
                          type="date"
                          value={item.dueDate}
                          onChange={(event) => updateConfirmedTodoItem(item.id, { dueDate: event.target.value })}
                        />
                        {item.cadence === "weekdays" ? (
                          <span className="planner-chip planner-cadence">Weekdays</span>
                        ) : item.cadence === "daily" ? (
                          <span className="planner-chip planner-cadence">Daily</span>
                        ) : item.cadence === "times_per_week" && item.timesPerWeek ? (
                          <span className="planner-chip planner-cadence">{item.timesPerWeek}x/week</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="planner-generate-btn"
                    onClick={regenerateScheduleFromTodos}
                  >
                    Regenerate Schedule
                  </button>
                </>
              )}
            </div>
          )}
        </aside>

        <div className={`planner-column ${showPlannerColumn ? "open" : "closed"}`}>
          <div className="planner-list">
            <div className="planner-head">
              <span>Weekly Task List</span>
              <span>{plannerItems.filter((item) => !item.completed).length} active</span>
            </div>
            {plannerItems.length === 0 ? (
              <div className="planner-empty">
                Share your day/week tasks in chat. Aura will structure them with due dates, priorities, and estimates.
              </div>
            ) : (
              plannerItems.map((item) => (
                <div key={item.id} className={`planner-row ${item.completed ? "done" : ""}`}>
                  <button
                    type="button"
                    className={`planner-check ${item.completed ? "done" : ""}`}
                    onClick={() => updatePlannerItem(item.id, { completed: !item.completed })}
                    aria-label={item.completed ? "Mark active" : "Mark done"}
                  >
                    {item.completed ? "✓" : ""}
                  </button>
                  <input
                    className="planner-title-input"
                    value={item.title}
                    onChange={(event) => updatePlannerItem(item.id, { title: event.target.value })}
                  />
                  <div className="planner-meta-row">
                    <span className={`planner-chip ${item.kind === "deadline" ? "deadline" : "todo"}`}>
                      {item.kind === "deadline" ? "Deadline" : "To-do"}
                    </span>
                    <span className="planner-chip planner-category">{item.category}</span>
                    {item.cadence === "weekdays" ? (
                      <span className="planner-chip planner-cadence">Weekdays</span>
                    ) : item.cadence === "daily" ? (
                      <span className="planner-chip planner-cadence">Daily</span>
                    ) : item.cadence === "times_per_week" && item.timesPerWeek ? (
                      <span className="planner-chip planner-cadence">{item.timesPerWeek}x/week</span>
                    ) : null}
                    <select
                      className={`planner-chip planner-priority ${item.priority.toLowerCase()}`}
                      value={item.priority}
                      onChange={(event) =>
                        updatePlannerItem(item.id, { priority: event.target.value as PriorityTag })
                      }
                      aria-label="Select priority"
                    >
                      <option value="High">High</option>
                      <option value="Medium">Medium</option>
                      <option value="Low">Low</option>
                    </select>
                    <input
                      className="planner-date"
                      type="date"
                      value={item.dueDate}
                      onChange={(event) => updatePlannerItem(item.id, { dueDate: event.target.value })}
                    />
                    {item.fixedTime ? (
                      <span className="planner-chip planner-fixed-time">{item.fixedTime}</span>
                    ) : null}
                    <label className="planner-estimate">
                      <input
                        type="number"
                        min={15}
                        step={15}
                        value={item.estimateMinutes}
                        onChange={(event) =>
                          updatePlannerItem(item.id, {
                            estimateMinutes: Math.max(15, Number(event.target.value) || 15)
                          })
                        }
                      />
                      min
                    </label>
                    <button
                      type="button"
                      className="planner-delete"
                      onClick={() => removePlannerItem(item.id)}
                      aria-label="Delete task"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))
            )}
            <button
              type="button"
              className="planner-generate-btn"
              onClick={generateProjectedPlan}
              disabled={plannerItems.filter((item) => !item.completed).length === 0}
            >
              Generate Plan
            </button>
            {projectedBlocks.length > 0 ? (
              <div className="planner-plan-actions">
                <button type="button" className="planner-confirm-btn" onClick={confirmProjectedPlan}>
                  Confirm Plan
                </button>
                <button type="button" className="planner-clear-btn" onClick={discardProjectedPlan}>
                  Clear Draft
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className={`cal-main ${auraMode ? "aura-on" : ""}`} ref={calMainRef}>
          <div className="cal-header">
            <button className="cal-nav-btn" type="button" onClick={navPrev}>
              ‹
            </button>
            <button className="cal-nav-btn" type="button" onClick={navNext}>
              ›
            </button>
            <h1 className="cal-period">{periodTitle}</h1>
            <label className="view-select-wrap">
              <span>
                {curView === "day"
                  ? "Day"
                  : curView === "week"
                    ? "Week"
                    : curView === "month"
                      ? "Month"
                      : "3 Days"}
              </span>
              <span className="view-chevron">▾</span>
              <select
                value={curView}
                onChange={(event) => handleViewChange(event.target.value as ViewMode)}
                aria-label="Select calendar view"
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="3days">3 Days</option>
              </select>
            </label>
            <div className="cal-spacer" />
            <button
              className={`aura-header-btn ${auraMode ? "active" : ""}`}
              type="button"
              onClick={() => setAuraMode((current) => !current)}
            >
              <div className="aura-sphere aura-header-dot" />
              <span>{auraMode ? "Aura On" : "Aura"}</span>
            </button>
          </div>

          <div className={`cal-grid-wrap ${auraMode ? "aura-mode" : ""}`}>
            <div
              key={`${curView}-${periodTitle}-${gridAnimNonce}`}
              className={`cal-grid-content ${gridAnim === "next" ? "anim-next" : gridAnim === "prev" ? "anim-prev" : "anim-fade"}`}
            >
              {curView === "month" ? (
                <>
                  <div className="month-labels">
                    {DAYS_FULL.map((day) => (
                      <div key={day} className="month-lbl">
                        {day}
                      </div>
                    ))}
                  </div>
                  <div className="month-grid">
                    {monthCells.map((cell) => {
                      const dateKey = fmtDate(cell.date);
                      const cellEvents = events.filter((eventItem) => eventItem.date === dateKey).slice(0, 3);
                      return (
                        <div
                          key={`${dateKey}-${cell.dim ? "dim" : "norm"}`}
                          className={`month-cell ${cell.dim ? "dim" : ""} ${sameDay(cell.date, TODAY) ? "today" : ""}`}
                          onClick={() => {
                            triggerGridAnimation("fade");
                            setCurDate(new Date(cell.date));
                            setWkStart(weekOf(new Date(cell.date)));
                            setCurView("day");
                          }}
                        >
                          <div className="month-cell-num">{cell.date.getDate()}</div>
                        {cellEvents.map((eventItem) => (
                          <div
                            key={eventItem.id}
                            className={`month-ev ${eventItem.c} ${eventItem.done && isTodoColor(eventItem.c) ? "done" : ""}`}
                          >
                            {eventItem.done && isTodoColor(eventItem.c) ? "✓ " : ""}
                            {eventItem.title}
                          </div>
                        ))}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className="day-header-row"
                    style={{ gridTemplateColumns: `56px repeat(${colsForView(curView)},1fr)` }}
                  >
                    <div className="dh-spacer" />
                    {dateColumns.map((date) => {
                      const dayOfWeek = (date.getDay() + 6) % 7;
                      return (
                        <div
                          key={fmtDate(date)}
                          className={`dh-col ${sameDay(date, TODAY) ? "today" : ""}`}
                          title={date.toLocaleDateString("en-US", {
                            weekday: "long",
                            month: "long",
                            day: "numeric"
                          })}
                        >
                          <span className="dh-col-abbr">{DAYS_FULL[dayOfWeek]}</span>
                          <span className="dh-col-num">{date.getDate()}</span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="time-scroll" ref={timeScrollRef}>
                    <div
                      className="time-inner"
                      style={{ gridTemplateColumns: `56px repeat(${colsForView(curView)},1fr)` }}
                    >
                      <div className={`aura-flow-layer ${auraMode ? "on" : ""}`}>
                        <div className="aura-displace-layer" />
                        {auraSlots.map((slot) => (
                          <div
                            key={`slot-${slot.hour}`}
                            className="aura-slot-band"
                            style={{
                              top: slot.topPx,
                              opacity: slot.opacity,
                              background: `linear-gradient(180deg, transparent 0%, ${slot.color} 42%, transparent 100%)`
                            }}
                          />
                        ))}
                        {auraBlobs.map((blob) => (
                          <div
                            key={blob.key}
                            className="aura-blob"
                            style={{
                              left: `calc(${blob.leftPct}% - ${blob.widthPx / 2}px)`,
                              top: blob.topPx,
                              width: blob.widthPx,
                              height: blob.heightPx,
                              background: `radial-gradient(ellipse at 44% 42%, ${blob.color} 0%, rgba(255,255,255,0) 72%)`,
                              animationDelay: `${blob.delayMs}ms`
                            }}
                          />
                        ))}
                      </div>
                      <div className="time-label-col">
                        {Array.from({ length: 22 - START_H + 1 }, (_, i) => START_H + i).map((hour) => (
                          <div key={hour} className="time-lbl">
                            {hour < 12 ? `${hour}AM` : hour === 12 ? "12PM" : `${hour - 12}PM`}
                          </div>
                        ))}
                      </div>

                      {dateColumns.map((date) => {
                        const dateStr = fmtDate(date);
                        const dayEvents = events.filter((eventItem) => eventItem.date === dateStr);
                        const dayProjectedBlocks = projectedBlocks.filter((block) => block.date === dateStr);
                        return (
                          <div key={dateStr} className="day-col" data-date={dateStr}>
                            {auraMode
                              ? (auraHalosByDate[dateStr] ?? []).map((halo) => (
                                  <div
                                    key={halo.key}
                                    className="aura-event-halo"
                                    style={{
                                      top: halo.top,
                                      height: halo.height,
                                      background: `radial-gradient(ellipse at 50% 50%, ${halo.color} 0%, rgba(255,255,255,0) 70%)`
                                    }}
                                  />
                                ))
                              : null}
                            {Array.from({ length: 22 - START_H + 1 }, (_, i) => START_H + i).map((hour) => (
                              <div
                                key={`${dateStr}-${hour}`}
                                className="h-cell"
                                onClick={(event) => handleCellClick(event, dateStr, hour)}
                              />
                            ))}
                            {dayProjectedBlocks.map((block) => {
                              const top = (block.sh - START_H) * HOUR_H + 2;
                              const height = Math.max((block.eh - block.sh) * HOUR_H - 4, 16);
                              return (
                                <div
                                  key={block.id}
                                  className={`plan-ev-block ${dragState?.target === "projected" && dragState.itemId === block.id ? "drag-active" : ""}`}
                                  style={{ top, height }}
                                  onMouseDown={(event) => startProjectedBlockDrag(event, block)}
                                  onMouseEnter={(event) => {
                                    setHoveredProjectedId(block.id);
                                    const blockRect = event.currentTarget.getBoundingClientRect();
                                    const containerRect = calMainRef.current?.getBoundingClientRect();
                                    if (!containerRect) {
                                      return;
                                    }
                                    const popupWidth = 250;
                                    const rightSpace = containerRect.right - blockRect.right;
                                    const side: "right" | "left" = rightSpace > popupWidth + 16 ? "right" : "left";
                                    const x =
                                      side === "right"
                                        ? blockRect.right - containerRect.left + 10
                                        : blockRect.left - containerRect.left - popupWidth - 10;
                                    const y = blockRect.top - containerRect.top + Math.min(12, Math.max(2, blockRect.height * 0.22));
                                    setHoverReasonAnchor({ x, y, side });
                                  }}
                                  onMouseLeave={() => {
                                    setHoveredProjectedId((current) => (current === block.id ? null : current));
                                    setHoverReasonAnchor(null);
                                  }}
                                >
                                  <span className="plan-ev-title">{block.title}</span>
                                </div>
                              );
                            })}
                            {dayEvents.map((eventItem) => {
                              const top = (eventItem.sh - START_H) * HOUR_H + 2;
                              const height = Math.max((eventItem.eh - eventItem.sh) * HOUR_H - 4, 16);
                              return (
                                <div
                                  key={eventItem.id}
                                  className={`ev-block ${eventItem.c} ${auraMode ? "glass" : ""} ${dragState?.target === "event" && dragState.itemId === eventItem.id ? "drag-active" : ""}`}
                                  style={{ top, height }}
                                  onMouseDown={(event) => startEventDrag(event, eventItem, "move")}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (suppressClickEventId === eventItem.id) {
                                      return;
                                    }
                                    openEventEditor(eventItem);
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="ev-resize-handle top"
                                    onMouseDown={(event) => startEventDrag(event, eventItem, "resize-start")}
                                    aria-label="Adjust start time"
                                  />
                                  {isTodoColor(eventItem.c) ? (
                                    <button
                                      type="button"
                                      className={`ev-check ${eventItem.done ? "done" : ""}`}
                                      onMouseDown={(event) => {
                                        event.stopPropagation();
                                      }}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        toggleEventDone(eventItem.id);
                                      }}
                                      aria-label={eventItem.done ? "Mark as not done" : "Mark as done"}
                                    >
                                      {eventItem.done ? "✓" : ""}
                                    </button>
                                  ) : null}
                                  <span className={`ev-title ${eventItem.done && isTodoColor(eventItem.c) ? "done" : ""}`}>
                                    {eventItem.title}
                                  </span>
                                  <button
                                    type="button"
                                    className="ev-resize-handle bottom"
                                    onMouseDown={(event) => startEventDrag(event, eventItem, "resize-end")}
                                    aria-label="Adjust end time"
                                  />
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          {hoveredProjectedBlock && hoverReasonAnchor ? (
            <div
              className={`plan-reason-popup ${hoverReasonAnchor.side === "left" ? "left-side" : "right-side"}`}
              style={{
                left: hoverReasonAnchor.x,
                top: hoverReasonAnchor.y
              }}
            >
              <div className="plan-reason-title">Why this slot</div>
              <div className="plan-reason-body">{hoveredProjectedBlock.reason}</div>
            </div>
          ) : null}

          <button className="log-aura-outer" type="button" onClick={openAuraPopup}>
            <div className="log-aura-text">
              <span className="log-aura-label">Log Your Aura</span>
            </div>
            <div className="aura-sphere log-aura-sphere-btn" />
          </button>
        </div>
      </div>

      <div className={`body-wrap ${activeTab === "insights" ? "" : "hidden"}`} id="view-insights">
        <div style={{ width: "269px", flexShrink: 0 }} />
        <div className="insights-wrap">
          <div className="i-card">
            <div className="i-card-title">AI Profile</div>
            <div className="i-row">Timezone: {energyProfile.timezone}</div>
            <div className="i-row">Intervals detected: {energyProfile.intervals.length}</div>
            {energyProfile.intervals.length === 0 ? (
              <div className="i-row">
                No energy intervals yet. Use the Log Your Aura popup to add patterns.
              </div>
            ) : (
              energyProfile.intervals.map((interval) => (
                <div key={interval.id} className="i-row">
                  {describeEnergyInterval(interval)}
                </div>
              ))
            )}
            {energyProfile.freeform_notes?.trim() ? (
              <div className="i-row">
                Notes: {energyProfile.freeform_notes.trim()}
              </div>
            ) : null}
          </div>

          <div className="i-card">
            <div className="i-card-title">Menstrual Cycle Patterns</div>
            <div className="donut-row">
              <svg width="120" height="120" viewBox="0 0 120 120" style={{ flexShrink: 0 }}>
                <circle cx="60" cy="60" r="44" fill="none" stroke="#F5E0E0" strokeWidth="18" />
                <circle
                  cx="60"
                  cy="60"
                  r="44"
                  fill="none"
                  stroke="#F09090"
                  strokeWidth="18"
                  strokeDasharray="110 166"
                  strokeDashoffset="0"
                  transform="rotate(-90 60 60)"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="44"
                  fill="none"
                  stroke="#F5AAAA"
                  strokeWidth="18"
                  strokeDasharray="97 179"
                  strokeDashoffset="-110"
                  transform="rotate(-90 60 60)"
                />
                <circle
                  cx="60"
                  cy="60"
                  r="44"
                  fill="none"
                  stroke="#F9D0D0"
                  strokeWidth="18"
                  strokeDasharray="69 207"
                  strokeDashoffset="-207"
                  transform="rotate(-90 60 60)"
                />
              </svg>
              <div className="cycle-list">
                <div className="cycle-item">
                  <strong>Menstrual:</strong> Eating nutrient-dense, magnesium-rich foods to combat cravings and bloating
                </div>
                <div className="cycle-item">
                  <strong>Follicular:</strong> Eating nutrient-dense, magnesium-rich foods to combat cravings and bloating
                </div>
                <div className="cycle-item">
                  <strong>Ovular:</strong> Eating nutrient-dense, magnesium-rich foods to combat cravings and bloating
                </div>
                <div className="i-load">Load more...</div>
              </div>
            </div>
          </div>

          <div className="i-card">
            <div className="i-card-title">Energy Landscape</div>
            <div className="energy-toggle">
              <button
                type="button"
                className={`e-btn ${energyTab === "day" ? "active" : ""}`}
                onClick={() => setEnergyTab("day")}
              >
                Day
              </button>
              <button
                type="button"
                className={`e-btn ${energyTab === "week" ? "active" : ""}`}
                onClick={() => setEnergyTab("week")}
              >
                Week
              </button>
              <button
                type="button"
                className={`e-btn ${energyTab === "month" ? "active" : ""}`}
                onClick={() => setEnergyTab("month")}
              >
                Month
              </button>
              <button
                type="button"
                className={`e-btn ${energyTab === "year" ? "active" : ""}`}
                onClick={() => setEnergyTab("year")}
              >
                Year
              </button>
            </div>
            <div className="chart-wrap">
              <svg viewBox="0 0 460 150" width="100%" height="100%" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#F09090" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#F09090" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path
                  d="M0,120 C20,110 40,80 70,60 C100,40 110,30 140,28 C170,26 185,55 210,65 C235,75 250,105 280,100 C305,96 320,70 350,60 C375,52 405,72 440,80 L440,150 L0,150 Z"
                  fill="url(#eg)"
                />
                <path
                  d="M0,120 C20,110 40,80 70,60 C100,40 110,30 140,28 C170,26 185,55 210,65 C235,75 250,105 280,100 C305,96 320,70 350,60 C375,52 405,72 440,80"
                  stroke="#F09090"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>

          <div className="i-card">
            <div className="i-card-title">Avoidance Patterns</div>
            <div className="i-row">You perform better when studying a week in advance</div>
            <div className="i-row">You perform 23% worse when you study the night before.</div>
            <div className="i-row">Best performance when final session is 36 hours prior.</div>
            <div className="i-load">Load more...</div>
          </div>
        </div>
      </div>

      <div
        className={`overlay ${overlayOpen ? "on" : ""}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            closePopup();
          }
        }}
      >
        <div className="aura-popup">
          <button className="popup-close" type="button" onClick={closePopup}>
            ×
          </button>

          <div className={`${popupStep === 1 ? "" : "hidden"}`} style={{ display: popupStep === 1 ? "flex" : "none", width: "100%" }}>
            <div className="popup-left">
              <div className="aura-sphere popup-logo" />
              <div className="popup-prompt">How was your day today?</div>
              <textarea
                ref={dayInputRef}
                className="popup-textarea"
                placeholder="Type anything..."
                value={dayInput}
                onChange={(event) => setDayInput(event.target.value)}
              />
              <div className="popup-input-btns">
                <button className="popup-mic-btn" type="button">
                  🎤
                </button>
                <button
                  className="popup-send-btn aura-sphere"
                  type="button"
                  onClick={() => {
                    void submitDay();
                  }}
                  disabled={energySaveState === "saving" || dayInput.trim().length === 0}
                >
                  ↑
                </button>
              </div>
            </div>
            <div className="popup-right">
              <div className="popup-sched-title">{popupDayTitle}</div>
              <div className="popup-sched-body">
                <div className="popup-events-area" style={{ height: totalScheduleHeight }}>
                  {popupHours.map((hour) => (
                    <div
                      key={`popup-grid-${hour}`}
                      className="popup-grid-line"
                      style={{ top: (hour - POPUP_START_H) * POPUP_HOUR_H }}
                    />
                  ))}
                  {popupDayEvents.map((item) => {
                    const clippedStart = Math.max(item.sh, POPUP_START_H);
                    const clippedEnd = Math.min(item.eh, POPUP_END_H);
                    if (clippedEnd <= clippedStart) {
                      return null;
                    }
                    const top = (clippedStart - POPUP_START_H) * POPUP_HOUR_H;
                    const height = Math.max((clippedEnd - clippedStart) * POPUP_HOUR_H, 20);
                    return (
                      <div
                        key={`popup-live-${item.id}`}
                        className={`popup-sched-event ${item.c}`}
                        style={{ top, height }}
                      >
                        {item.title}
                      </div>
                    );
                  })}
                </div>
                <div className="popup-time-col" style={{ height: totalScheduleHeight }}>
                  {popupHours.map((hour) => (
                    <div
                      key={hour}
                      className="popup-time-lbl"
                      style={{ top: (hour - POPUP_START_H) * POPUP_HOUR_H }}
                    >
                      {hour < 12 ? `${hour}AM` : hour === 12 ? "12PM" : `${hour - 12}PM`}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className={`${popupStep === 2 ? "" : "hidden"}`} style={{ display: popupStep === 2 ? "flex" : "none", width: "100%" }}>
            <div className="popup-left">
              <div className="aura-sphere popup-logo" />
              <div className="popup-prompt">Status</div>
              <div className="summary-body">{popupSummaryMessage}</div>
              <button className="save-btn" type="button" onClick={saveInsights}>
                Done
              </button>
              <button className="skip-link" type="button" onClick={closePopup}>
                Close
              </button>
            </div>
            <div className="popup-right">
              <div className="popup-sched-title">{popupDayTitle}</div>
              <div className="popup-sched-body">
                <div className="popup-events-area" style={{ height: totalScheduleHeight }}>
                  {popupHours.map((hour) => (
                    <div
                      key={`popup-grid-2-${hour}`}
                      className="popup-grid-line"
                      style={{ top: (hour - POPUP_START_H) * POPUP_HOUR_H }}
                    />
                  ))}
                  {popupDayEvents.map((item) => {
                    const clippedStart = Math.max(item.sh, POPUP_START_H);
                    const clippedEnd = Math.min(item.eh, POPUP_END_H);
                    if (clippedEnd <= clippedStart) {
                      return null;
                    }
                    const top = (clippedStart - POPUP_START_H) * POPUP_HOUR_H;
                    const height = Math.max((clippedEnd - clippedStart) * POPUP_HOUR_H, 20);
                    return (
                      <div
                        key={`popup-live-status-${item.id}`}
                        className={`popup-sched-event ${item.c}`}
                        style={{ top, height }}
                      >
                        {item.title}
                      </div>
                    );
                  })}
                </div>
                <div className="popup-time-col" style={{ height: totalScheduleHeight }}>
                  {popupHours.map((hour) => (
                    <div
                      key={hour}
                      className="popup-time-lbl"
                      style={{ top: (hour - POPUP_START_H) * POPUP_HOUR_H }}
                    >
                      {hour < 12 ? `${hour}AM` : hour === 12 ? "12PM" : `${hour - 12}PM`}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={eventPopupRef}
        className={`event-popup ${eventPopup.open ? "on" : ""}`}
        style={{ left: eventPopup.x, top: eventPopup.y }}
      >
        <div className="ep-head">New Event</div>
        <input
          type="text"
          className="ep-input"
          placeholder="Event name"
          value={eventPopup.name}
          onChange={(event) => setEventPopup((current) => ({ ...current, name: event.target.value }))}
        />
        <input
          type="text"
          className="ep-input"
          placeholder="Location (optional)"
          value={eventPopup.location}
          onChange={(event) => setEventPopup((current) => ({ ...current, location: event.target.value }))}
        />
        <div className="ep-time-row">
          <input
            type="time"
            className="ep-time"
            value={eventPopup.start}
            onChange={(event) => setEventPopup((current) => ({ ...current, start: event.target.value }))}
          />
          <span className="ep-sep">-</span>
          <input
            type="time"
            className="ep-time"
            value={eventPopup.end}
            onChange={(event) => setEventPopup((current) => ({ ...current, end: event.target.value }))}
          />
        </div>
        <div className="ep-color-row">
          {([
            { color: "dark", style: "#F09090" },
            { color: "light", style: "rgba(240,153,153,0.4)" },
            { color: "blue", style: "#99c4f0" },
            { color: "blueLight", style: "rgba(153,196,240,0.38)" },
            { color: "green", style: "#99e0b4" },
            { color: "greenLight", style: "rgba(153,224,180,0.38)" }
          ] as const).map((colorItem) => (
            <button
              key={colorItem.color}
              type="button"
              className={`ep-color ${eventPopup.color === colorItem.color ? "selected" : ""}`}
              style={{ background: colorItem.style }}
              onClick={() => setEventPopup((current) => ({ ...current, color: colorItem.color }))}
              aria-label={`Select ${colorItem.color} color`}
            />
          ))}
        </div>
        <div className="ep-btns">
          <button type="button" className="ep-cancel" onClick={closeEventPopup}>
            Cancel
          </button>
          <button type="button" className="ep-save" onClick={saveEvent}>
            Save
          </button>
        </div>
      </div>

      <div
        className={`event-editor-overlay ${eventEditor.open ? "on" : ""}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setEventEditor((current) => ({ ...current, open: false }));
          }
        }}
      >
        <div className="event-editor-modal">
          <div className="event-editor-title">Edit Event</div>
          <div className="event-editor-date">{eventEditor.date}</div>
          <input
            type="text"
            className="ep-input"
            value={eventEditor.title}
            onChange={(event) => setEventEditor((current) => ({ ...current, title: event.target.value }))}
          />
          <div className="ep-time-row">
            <input
              type="time"
              className="ep-time"
              value={eventEditor.start}
              onChange={(event) => setEventEditor((current) => ({ ...current, start: event.target.value }))}
            />
            <span className="ep-sep">-</span>
            <input
              type="time"
              className="ep-time"
              value={eventEditor.end}
              onChange={(event) => setEventEditor((current) => ({ ...current, end: event.target.value }))}
            />
          </div>
          <div className="ep-color-row">
            {([
              { color: "dark", style: "#F09090" },
              { color: "light", style: "rgba(240,153,153,0.4)" },
              { color: "blue", style: "#99c4f0" },
              { color: "blueLight", style: "rgba(153,196,240,0.38)" },
              { color: "green", style: "#99e0b4" },
              { color: "greenLight", style: "rgba(153,224,180,0.38)" }
            ] as const).map((colorItem) => (
              <button
                key={colorItem.color}
                type="button"
                className={`ep-color ${eventEditor.color === colorItem.color ? "selected" : ""}`}
                style={{ background: colorItem.style }}
                onClick={() => setEventEditor((current) => ({ ...current, color: colorItem.color }))}
                aria-label={`Select ${colorItem.color} color`}
              />
            ))}
          </div>
          <div className="event-editor-actions">
            <button
              type="button"
              className="ep-cancel"
              onClick={() => setEventEditor((current) => ({ ...current, open: false }))}
            >
              Cancel
            </button>
            <button type="button" className="event-delete" onClick={deleteEditedEvent}>
              Delete
            </button>
            <button type="button" className="ep-save" onClick={saveEditedEvent}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
