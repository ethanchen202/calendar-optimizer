import type {
  CalendarEvent,
  MessageResponse,
  ScheduleResponse,
  Task,
  UserState
} from "./types";

type RequestOptions = {
  method?: string;
  body?: unknown;
};

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async getUserState(userId: string): Promise<UserState> {
    return this.request<UserState>(`/api/v1/state/${encodeURIComponent(userId)}`);
  }

  async syncTasks(userId: string, tasks: Task[]): Promise<UserState> {
    return this.request<UserState>("/api/v1/tasks/sync", {
      method: "POST",
      body: { user_id: userId, tasks }
    });
  }

  async deleteTask(userId: string, taskId: string): Promise<MessageResponse> {
    const query = new URLSearchParams({ user_id: userId });
    return this.request<MessageResponse>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}?${query.toString()}`,
      { method: "DELETE" }
    );
  }

  async updateEnergyProfile(userId: string, description: string): Promise<MessageResponse> {
    return this.request<MessageResponse>("/api/v1/energy-profile", {
      method: "POST",
      body: { user_id: userId, description }
    });
  }

  async generateSchedule(input: {
    userId: string;
    currentCalendar: CalendarEvent[];
    newTasks: Task[];
    userDescription: string;
    planningHorizonDays: number;
    timezone: string;
    useAI: boolean;
  }): Promise<ScheduleResponse> {
    return this.request<ScheduleResponse>("/api/v1/schedule/generate", {
      method: "POST",
      body: {
        user_id: input.userId,
        current_calendar: input.currentCalendar,
        new_tasks: input.newTasks,
        user_description: input.userDescription,
        planning_horizon_days: input.planningHorizonDays,
        timezone: input.timezone,
        use_ai: input.useAI
      }
    });
  }

  async submitCheckin(input: {
    userId: string;
    feedback: string;
    satisfaction?: number;
  }): Promise<MessageResponse> {
    return this.request<MessageResponse>("/api/v1/checkins", {
      method: "POST",
      body: {
        user_id: input.userId,
        feedback: input.feedback,
        satisfaction: input.satisfaction
      }
    });
  }

  async health(): Promise<{ status: string; ai_provider: string }> {
    return this.request<{ status: string; ai_provider: string }>("/health");
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail =
        typeof payload?.detail === "string"
          ? payload.detail
          : typeof payload?.message === "string"
            ? payload.message
            : `Request failed: ${response.status}`;
      throw new Error(detail);
    }

    return payload as T;
  }
}

