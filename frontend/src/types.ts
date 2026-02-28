export type TimeWindow = {
  start_hour: number;
  end_hour: number;
};

export type Task = {
  id: string;
  title: string;
  duration_minutes: number;
  priority: number;
  deadline?: string | null;
  preferred_time_window?: TimeWindow | null;
  split_allowed: boolean;
};

export type CalendarEvent = {
  id?: string | null;
  title: string;
  start: string;
  end: string;
};

export type CheckinRecord = {
  feedback: string;
  satisfaction?: number | null;
  submitted_at: string;
};

export type UserState = {
  user_id: string;
  tasks: Task[];
  calendar_events: CalendarEvent[];
  energy_profile?: string | null;
  checkins: CheckinRecord[];
};

export type ScheduledEvent = {
  id: string;
  title: string;
  task_id: string;
  start: string;
  end: string;
  source: "gemini" | "heuristic";
};

export type UnscheduledTask = {
  task_id: string;
  reason: string;
};

export type ScheduleResponse = {
  user_id: string;
  generated_at: string;
  strategy_used: "gemini" | "heuristic";
  schedule_events: ScheduledEvent[];
  unscheduled_tasks: UnscheduledTask[];
};

export type MessageResponse = {
  message: string;
};

export type ChatDelta = {
  tasks_add: Task[];
  task_ids_remove: string[];
  task_title_contains_remove: string[];
  calendar_add: CalendarEvent[];
  calendar_ids_remove: string[];
  calendar_title_contains_remove: string[];
  energy_profile_append?: string | null;
  energy_profile_replace?: string | null;
};

export type ChatAnalyzeResponse = {
  user_id: string;
  assistant_message: string;
  detected_emotions: string[];
  proposed_delta: ChatDelta;
  requires_confirmation: boolean;
  delta_preview: string[];
  updated_energy_profile?: string | null;
};

export type ChatApplyResponse = {
  message: string;
  user_state: UserState;
};
