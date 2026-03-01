import { useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent
} from "react";
import { ApiClient } from "./api";
import type {
  CalendarEvent as BackendCalendarEvent,
  EnergyInterval,
  EnergyProfile
} from "./types";

type ViewMode = "week" | "month" | "day" | "3days";
type TopTab = "calendar" | "insights";
type EnergyTab = "day" | "week" | "month" | "year";
type SidebarMode = "chat" | "todo";
type ColorClass = "dark" | "light" | "blue" | "green";

type EventItem = {
  id: number;
  backendId?: string;
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
  eventId: number;
  mode: DragMode;
  startY: number;
  startSh: number;
  startEh: number;
  startDate: string;
  moved: boolean;
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
const COLOR_ORDER: ColorClass[] = ["dark", "light", "blue", "green"];
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const EMPTY_ENERGY_PROFILE: EnergyProfile = {
  version: 1,
  timezone: DEFAULT_TIMEZONE,
  intervals: [],
  freeform_notes: null,
  updated_at: null
};

const SCHEDULE = [
  { title: "ADV250", sh: 9, eh: 10, c: "dark", emoji: "😴" },
  { title: "Studying", sh: 10, eh: 10.67, c: "light", emoji: null },
  { title: "Brunch", sh: 11, eh: 11.67, c: "light", emoji: "😁" },
  { title: "MATH257", sh: 12, eh: 13.67, c: "dark", emoji: "🤓" },
  { title: "Studying for CS173", sh: 14, eh: 15.25, c: "light", emoji: "🥱" },
  { title: "Client Call", sh: 15.5, eh: 16.25, c: "dark", emoji: null },
  { title: "Dinner", sh: 16.5, eh: 17.25, c: "light", emoji: "🙂" }
] as const;

const SCHED_START = 9;
const SCHED_END = 17;
const SCHED_HOUR_H = 52;

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
    const seed = item.id && item.id.trim() ? item.id : `${item.title}-${item.start}`;
    mapped.push({
      id: localId,
      backendId: item.id ?? `calendar_${localId}`,
      date: fmtDate(start),
      sh,
      eh,
      title: item.title,
      c: eventColorFromSeed(seed),
      done: false
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
      id: item.backendId ?? `calendar_${item.id}`,
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
  const [energyProfile, setEnergyProfile] = useState<EnergyProfile>(EMPTY_ENERGY_PROFILE);
  const [energySaveState, setEnergySaveState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [popupSummaryMessage, setPopupSummaryMessage] = useState("Updated energy profile");

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "assistant",
      text: "Hi! I'm your scheduling assistant. Ask me anything about your calendar."
    }
  ]);

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
  const skipNextCalendarSyncRef = useRef(true);

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

  async function refreshCalendarFromBackend() {
    setCalendarSyncState("loading");
    setCalendarSyncMessage("Loading calendar...");
    try {
      const state = await api.getUserState(userId);
      const mappedEvents = mapBackendEventsToUiEvents(state.calendar_events ?? []);
      setEnergyProfile(state.energy_profile ?? EMPTY_ENERGY_PROFILE);
      skipNextCalendarSyncRef.current = true;
      setEvents(mappedEvents);
      setNextId(mappedEvents.reduce((maxId, item) => Math.max(maxId, item.id), 0) + 1);

      if (mappedEvents.length > 0) {
        const firstDate = parseDateKey(mappedEvents[0].date);
        if (firstDate) {
          setCurDate(firstDate);
          setWkStart(weekOf(firstDate));
          setMthDate(new Date(firstDate.getFullYear(), firstDate.getMonth(), 1));
        }
      }
      setCalendarSyncState("ready");
      setCalendarSyncMessage(
        `Loaded ${mappedEvents.length} event${mappedEvents.length === 1 ? "" : "s"} from backend.`
      );
    } catch (error) {
      setCalendarSyncState("error");
      setCalendarSyncMessage(`Failed to load calendar: ${getErrorMessage(error)}`);
    } finally {
      setCalendarReady(true);
    }
  }

  async function syncCalendarToBackend(nextEvents: EventItem[]) {
    try {
      setCalendarSyncState("syncing");
      setCalendarSyncMessage("Saving calendar...");
      const payload = mapUiEventsToBackendEvents(nextEvents);
      await api.syncCalendar(userId, payload);
      setCalendarSyncState("ready");
      setCalendarSyncMessage(`Synced ${payload.length} event${payload.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setCalendarSyncState("error");
      setCalendarSyncMessage(`Calendar sync failed: ${getErrorMessage(error)}`);
    }
  }

  useEffect(() => {
    void refreshCalendarFromBackend();
  }, [api]);

  useEffect(() => {
    if (!calendarReady) {
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
      if (didMove && !dragState.moved) {
        setSuppressClickEventId(dragState.eventId);
        setDragState((current) => (current ? { ...current, moved: true } : current));
      }
      const deltaHours = snapQuarter((event.clientY - dragState.startY) / HOUR_H);

      setEvents((current) =>
        current.map((item) => {
          if (item.id !== dragState.eventId) {
            return item;
          }

          const nextDate = (() => {
            const el = document.elementFromPoint(event.clientX, event.clientY);
            const target = el?.closest(".day-col[data-date]") as HTMLElement | null;
            return target?.dataset.date ?? dragState.startDate;
          })();

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
    setEnergySaveState("saving");
    setPopupSummaryMessage("Updating energy profile...");
    setPopupStep(2);
    try {
      await api.updateEnergyProfile(userId, description);
      await refreshCalendarFromBackend();
      setEnergySaveState("success");
      setPopupSummaryMessage("Updated energy profile");
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
        if (item.id !== eventId || item.c !== "light") {
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
      eventId: eventItem.id,
      mode,
      startY: event.clientY,
      startSh: eventItem.sh,
      startEh: eventItem.eh,
      startDate: eventItem.date,
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

  function sendChat() {
    const message = chatInput.trim();
    if (!message) {
      return;
    }
    const userMessageId = Date.now();
    setChatMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", text: message }
    ]);
    setChatInput("");
    window.setTimeout(() => {
      setChatMessages((current) => [
        ...current,
        {
          id: userMessageId + 1,
          role: "assistant",
          text: "Thanks, I noted that."
        }
      ]);
    }, 350);
  }

  function onChatKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  }

  function handleCalendarWheel(container: HTMLDivElement, deltaY: number) {
    if (container.scrollHeight <= container.clientHeight) {
      return;
    }
    container.scrollTop += deltaY;
  }

  function handleCalendarWheelCapture(event: ReactWheelEvent<HTMLDivElement>) {
    if (curView === "month" || !timeScrollRef.current) {
      return;
    }
    event.preventDefault();
    handleCalendarWheel(timeScrollRef.current, event.deltaY);
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

  const totalScheduleHeight = (SCHED_END - SCHED_START) * SCHED_HOUR_H;

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
              onChange={(event) => setSidebarMode(event.target.value as SidebarMode)}
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
                color: calendarSyncState === "error" ? "#B42318" : "#4E4A67"
              }}
            >
              {calendarSyncState === "loading"
                ? "Connecting backend..."
                : calendarSyncState === "syncing"
                  ? "Saving calendar..."
                  : calendarSyncState === "error"
                    ? "Backend sync failed"
                    : "Backend connected"}
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
              </div>
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
                    onClick={sendChat}
                    disabled={chatInput.trim().length === 0}
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
              <div className="todo-item">Review ADV250 notes</div>
              <div className="todo-item">Submit MATH257 problem set</div>
              <div className="todo-item">Prep for client call</div>
              <div className="todo-item">Plan CS173 study block</div>
            </div>
          )}
        </aside>

        <div className={`cal-main ${auraMode ? "aura-on" : ""}`}>
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

          <div
            className={`cal-grid-wrap ${auraMode ? "aura-mode" : ""}`}
            onWheelCapture={handleCalendarWheelCapture}
          >
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
                            className={`month-ev ${eventItem.c} ${eventItem.done && eventItem.c === "light" ? "done" : ""}`}
                          >
                            {eventItem.done && eventItem.c === "light" ? "✓ " : ""}
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

                  <div
                    className="time-scroll"
                    ref={timeScrollRef}
                    onWheel={(event) => handleCalendarWheel(event.currentTarget, event.deltaY)}
                  >
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
                            {dayEvents.map((eventItem) => {
                              const top = (eventItem.sh - START_H) * HOUR_H + 2;
                              const height = Math.max((eventItem.eh - eventItem.sh) * HOUR_H - 4, 16);
                              return (
                                <div
                                  key={eventItem.id}
                                  className={`ev-block ${eventItem.c} ${auraMode ? "glass" : ""} ${dragState?.eventId === eventItem.id ? "drag-active" : ""}`}
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
                                  {eventItem.c === "light" ? (
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
                                  <span className={`ev-title ${eventItem.done && eventItem.c === "light" ? "done" : ""}`}>
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
              <div className="popup-sched-title">Tuesday</div>
              <div className="popup-sched-body">
                <div className="popup-events-area" style={{ height: totalScheduleHeight }}>
                  {SCHEDULE.map((item) => {
                    const top = (item.sh - SCHED_START) * SCHED_HOUR_H;
                    const height = Math.max((item.eh - item.sh) * SCHED_HOUR_H, 24);
                    return (
                      <div
                        key={`${item.title}-${item.sh}`}
                        className={`popup-sched-event ${item.c} ${item.emoji ? "has-emoji" : ""}`}
                        style={{ top, height }}
                      >
                        {item.title}
                      </div>
                    );
                  })}
                </div>
                <div className="popup-time-col" style={{ height: totalScheduleHeight }}>
                  {Array.from({ length: SCHED_END - SCHED_START + 1 }, (_, idx) => SCHED_START + idx).map((hour) => (
                    <div
                      key={hour}
                      className="popup-time-lbl"
                      style={{ top: (hour - SCHED_START) * SCHED_HOUR_H }}
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
              <div className="popup-sched-title">Tuesday</div>
              <div className="popup-sched-body">
                <div className="popup-events-area" style={{ height: totalScheduleHeight }}>
                  {SCHEDULE.map((item, index) => {
                    const top = (item.sh - SCHED_START) * SCHED_HOUR_H;
                    const height = Math.max((item.eh - item.sh) * SCHED_HOUR_H, 24);
                    return (
                      <div
                        key={`${item.title}-${item.sh}`}
                        className={`popup-sched-event ${item.c} ${item.emoji ? "has-emoji" : ""}`}
                        style={{ top, height }}
                      >
                        {item.title}
                        {item.emoji ? (
                          <div className="popup-emoji-badge" style={{ animationDelay: `${index * 80 + 120}ms` }}>
                            {item.emoji}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="popup-time-col" style={{ height: totalScheduleHeight }}>
                  {Array.from({ length: SCHED_END - SCHED_START + 1 }, (_, idx) => SCHED_START + idx).map((hour) => (
                    <div
                      key={hour}
                      className="popup-time-lbl"
                      style={{ top: (hour - SCHED_START) * SCHED_HOUR_H }}
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
            { color: "green", style: "#99e0b4" }
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
              { color: "green", style: "#99e0b4" }
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
