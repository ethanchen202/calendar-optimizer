import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiClient } from "./api";
import type {
  CalendarEvent,
  CheckinRecord,
  ScheduleResponse,
  Task
} from "./types";

const DEFAULT_API_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(() => {
    return localStorage.getItem("calendar_optimizer_api_base") ?? DEFAULT_API_URL;
  });
  const [userId, setUserId] = useState(() => {
    return localStorage.getItem("calendar_optimizer_user_id") ?? "user_123";
  });

  const [backendHealth, setBackendHealth] = useState<string>("unknown");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const [tasks, setTasks] = useState<Task[]>([]);
  const [energyProfile, setEnergyProfile] = useState<string>("");
  const [checkins, setCheckins] = useState<CheckinRecord[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);

  const [taskTitle, setTaskTitle] = useState("");
  const [taskDuration, setTaskDuration] = useState("60");
  const [taskPriority, setTaskPriority] = useState("3");
  const [taskDeadline, setTaskDeadline] = useState("");
  const [taskPrefStart, setTaskPrefStart] = useState("");
  const [taskPrefEnd, setTaskPrefEnd] = useState("");
  const [taskSplitAllowed, setTaskSplitAllowed] = useState(true);

  const [eventTitle, setEventTitle] = useState("");
  const [eventStart, setEventStart] = useState("");
  const [eventEnd, setEventEnd] = useState("");

  const [scheduleDescription, setScheduleDescription] = useState("");
  const [planningHorizonDays, setPlanningHorizonDays] = useState("7");
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [useAI, setUseAI] = useState(true);

  const [checkinFeedback, setCheckinFeedback] = useState("");
  const [checkinSatisfaction, setCheckinSatisfaction] = useState("");

  const [isLoadingState, setIsLoadingState] = useState(false);
  const [isSavingTasks, setIsSavingTasks] = useState(false);
  const [isSavingEnergy, setIsSavingEnergy] = useState(false);
  const [isGeneratingSchedule, setIsGeneratingSchedule] = useState(false);
  const [isSubmittingCheckin, setIsSubmittingCheckin] = useState(false);

  const api = useMemo(() => new ApiClient(apiBaseUrl), [apiBaseUrl]);

  useEffect(() => {
    localStorage.setItem("calendar_optimizer_api_base", apiBaseUrl);
  }, [apiBaseUrl]);

  useEffect(() => {
    localStorage.setItem("calendar_optimizer_user_id", userId);
  }, [userId]);

  useEffect(() => {
    void checkBackendHealth();
  }, [api]);

  const clearMessages = () => {
    setStatusMessage("");
    setErrorMessage("");
  };

  const withErrorHandling = (message: string) => {
    clearMessages();
    setStatusMessage(message);
  };

  function requireUserId(): string {
    const trimmed = userId.trim();
    if (!trimmed) {
      throw new Error("User ID is required.");
    }
    return trimmed;
  }

  async function checkBackendHealth() {
    try {
      const health = await api.health();
      setBackendHealth(`${health.status} (${health.ai_provider})`);
    } catch {
      setBackendHealth("offline");
    }
  }

  async function loadUserState() {
    try {
      clearMessages();
      setIsLoadingState(true);
      const uid = requireUserId();
      const state = await api.getUserState(uid);
      setTasks(state.tasks);
      const profile = state.energy_profile ?? "";
      setEnergyProfile(profile);
      if (!scheduleDescription.trim()) {
        setScheduleDescription(profile);
      }
      setCheckins(state.checkins);
      setStatusMessage("Loaded state from backend.");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoadingState(false);
    }
  }

  async function saveTasks(nextTasks: Task[], successMessage: string) {
    try {
      setIsSavingTasks(true);
      clearMessages();
      const uid = requireUserId();
      const state = await api.syncTasks(uid, nextTasks);
      setTasks(state.tasks);
      setStatusMessage(successMessage);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSavingTasks(false);
    }
  }

  async function handleAddTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const title = taskTitle.trim();
      if (!title) {
        throw new Error("Task title is required.");
      }

      const duration = Number.parseInt(taskDuration, 10);
      const priority = Number.parseInt(taskPriority, 10);
      if (Number.isNaN(duration) || duration < 15 || duration > 720) {
        throw new Error("Duration must be between 15 and 720 minutes.");
      }
      if (Number.isNaN(priority) || priority < 1 || priority > 5) {
        throw new Error("Priority must be between 1 and 5.");
      }

      let preferredTimeWindow: Task["preferred_time_window"] = null;
      if (taskPrefStart !== "" || taskPrefEnd !== "") {
        const start = Number.parseInt(taskPrefStart, 10);
        const end = Number.parseInt(taskPrefEnd, 10);
        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end > 24 || end <= start) {
          throw new Error("Preferred window must be valid and end hour > start hour.");
        }
        preferredTimeWindow = { start_hour: start, end_hour: end };
      }

      const nextTask: Task = {
        id: `${slugify(title)}_${Date.now()}`,
        title,
        duration_minutes: duration,
        priority,
        deadline: taskDeadline ? new Date(taskDeadline).toISOString() : null,
        preferred_time_window: preferredTimeWindow,
        split_allowed: taskSplitAllowed
      };

      await saveTasks([...tasks, nextTask], `Added and synced "${title}".`);
      setTaskTitle("");
      setTaskDuration("60");
      setTaskPriority("3");
      setTaskDeadline("");
      setTaskPrefStart("");
      setTaskPrefEnd("");
      setTaskSplitAllowed(true);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }

  async function handleDeleteTask(taskId: string) {
    try {
      clearMessages();
      setIsSavingTasks(true);
      const uid = requireUserId();
      await api.deleteTask(uid, taskId);
      setTasks((current) => current.filter((task) => task.id !== taskId));
      setStatusMessage(`Deleted task "${taskId}".`);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSavingTasks(false);
    }
  }

  async function handleSaveEnergyProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      withErrorHandling("Saving energy profile...");
      setIsSavingEnergy(true);
      const uid = requireUserId();
      await api.updateEnergyProfile(uid, energyProfile);
      setStatusMessage("Energy profile saved.");
      if (!scheduleDescription.trim()) {
        setScheduleDescription(energyProfile);
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSavingEnergy(false);
    }
  }

  function handleAddCalendarEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const title = eventTitle.trim();
      if (!title) {
        throw new Error("Calendar event title is required.");
      }
      if (!eventStart || !eventEnd) {
        throw new Error("Calendar event start and end are required.");
      }

      const startDate = new Date(eventStart);
      const endDate = new Date(eventEnd);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
        throw new Error("Calendar event end must be after start.");
      }

      setCalendarEvents((current) => [
        ...current,
        {
          id: `event_${Date.now()}`,
          title,
          start: startDate.toISOString(),
          end: endDate.toISOString()
        }
      ]);
      setEventTitle("");
      setEventStart("");
      setEventEnd("");
      setStatusMessage("Added current calendar event.");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }

  function handleDeleteCalendarEvent(eventId: string | null | undefined) {
    if (!eventId) {
      return;
    }
    setCalendarEvents((current) => current.filter((item) => item.id !== eventId));
  }

  async function handleGenerateSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      clearMessages();
      setIsGeneratingSchedule(true);
      const uid = requireUserId();

      const horizon = Number.parseInt(planningHorizonDays, 10);
      if (Number.isNaN(horizon) || horizon < 1 || horizon > 30) {
        throw new Error("Planning horizon must be between 1 and 30 days.");
      }

      const response = await api.generateSchedule({
        userId: uid,
        currentCalendar: calendarEvents,
        newTasks: tasks,
        userDescription: scheduleDescription || energyProfile,
        planningHorizonDays: horizon,
        timezone: timezone.trim() || "UTC",
        useAI
      });
      setSchedule(response);
      setStatusMessage(`Schedule generated with ${response.strategy_used} strategy.`);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsGeneratingSchedule(false);
    }
  }

  async function handleSubmitCheckin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      clearMessages();
      setIsSubmittingCheckin(true);
      const uid = requireUserId();
      const feedback = checkinFeedback.trim();
      if (!feedback) {
        throw new Error("Check-in feedback is required.");
      }

      const satisfaction = checkinSatisfaction
        ? Number.parseInt(checkinSatisfaction, 10)
        : undefined;
      await api.submitCheckin({ userId: uid, feedback, satisfaction });
      setCheckinFeedback("");
      setCheckinSatisfaction("");
      setStatusMessage("Check-in submitted.");
      await loadUserState();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSubmittingCheckin(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="kicker">Calendar Optimizer MVP</p>
        <h1>Design your schedule around your energy, not just your to-do list.</h1>
        <p>
          Tasks and user profile are persisted in your FastAPI backend. Generated schedules are
          returned as JSON and rendered below.
        </p>
      </header>

      <section className="panel">
        <h2>Connection</h2>
        <div className="grid two">
          <label>
            Backend URL
            <input
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder="http://localhost:8000"
            />
          </label>
          <label>
            User ID
            <input
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              placeholder="user_123"
            />
          </label>
        </div>
        <div className="row">
          <button type="button" onClick={loadUserState} disabled={isLoadingState}>
            {isLoadingState ? "Loading..." : "Load State"}
          </button>
          <button type="button" onClick={() => void checkBackendHealth()}>
            Refresh Health
          </button>
          <span className="muted">Backend health: {backendHealth}</span>
        </div>
        {statusMessage ? <p className="status">{statusMessage}</p> : null}
        {errorMessage ? <p className="error">{errorMessage}</p> : null}
      </section>

      <div className="grid two">
        <section className="panel">
          <h2>Tasks</h2>
          <form onSubmit={handleAddTask} className="stack">
            <label>
              Task title
              <input
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="Write design doc"
              />
            </label>
            <div className="grid two">
              <label>
                Duration (minutes)
                <input
                  type="number"
                  min={15}
                  max={720}
                  value={taskDuration}
                  onChange={(event) => setTaskDuration(event.target.value)}
                />
              </label>
              <label>
                Priority (1-5)
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={taskPriority}
                  onChange={(event) => setTaskPriority(event.target.value)}
                />
              </label>
            </div>
            <label>
              Deadline (optional)
              <input
                type="datetime-local"
                value={taskDeadline}
                onChange={(event) => setTaskDeadline(event.target.value)}
              />
            </label>
            <div className="grid two">
              <label>
                Preferred start hour
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={taskPrefStart}
                  onChange={(event) => setTaskPrefStart(event.target.value)}
                  placeholder="16"
                />
              </label>
              <label>
                Preferred end hour
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={taskPrefEnd}
                  onChange={(event) => setTaskPrefEnd(event.target.value)}
                  placeholder="20"
                />
              </label>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={taskSplitAllowed}
                onChange={(event) => setTaskSplitAllowed(event.target.checked)}
              />
              Allow splitting into multiple blocks
            </label>
            <div className="row">
              <button type="submit" disabled={isSavingTasks}>
                {isSavingTasks ? "Saving..." : "Add + Sync Task"}
              </button>
              <button
                type="button"
                disabled={isSavingTasks}
                onClick={() => void saveTasks(tasks, "Synced task list.")}
              >
                Sync All Tasks
              </button>
            </div>
          </form>

          <ul className="list">
            {tasks.map((task) => (
              <li key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <p>
                    {task.duration_minutes} min | priority {task.priority} | split{" "}
                    {task.split_allowed ? "yes" : "no"}
                  </p>
                  {task.deadline ? <p>deadline: {new Date(task.deadline).toLocaleString()}</p> : null}
                </div>
                <button type="button" onClick={() => void handleDeleteTask(task.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Energy Profile</h2>
          <form onSubmit={handleSaveEnergyProfile} className="stack">
            <label>
              Typical daily energy notes
              <textarea
                value={energyProfile}
                onChange={(event) => setEnergyProfile(event.target.value)}
                rows={6}
                placeholder="I feel focused from 4-8 pm and tired from 1-3 pm..."
              />
            </label>
            <button type="submit" disabled={isSavingEnergy}>
              {isSavingEnergy ? "Saving..." : "Save Energy Profile"}
            </button>
          </form>
        </section>
      </div>

      <div className="grid two">
        <section className="panel">
          <h2>Current Calendar Input</h2>
          <form onSubmit={handleAddCalendarEvent} className="stack">
            <label>
              Event title
              <input
                value={eventTitle}
                onChange={(event) => setEventTitle(event.target.value)}
                placeholder="Class"
              />
            </label>
            <div className="grid two">
              <label>
                Start
                <input
                  type="datetime-local"
                  value={eventStart}
                  onChange={(event) => setEventStart(event.target.value)}
                />
              </label>
              <label>
                End
                <input
                  type="datetime-local"
                  value={eventEnd}
                  onChange={(event) => setEventEnd(event.target.value)}
                />
              </label>
            </div>
            <button type="submit">Add Calendar Event</button>
          </form>

          <ul className="list compact">
            {calendarEvents.map((event) => (
              <li key={event.id ?? `${event.title}_${event.start}`}>
                <div>
                  <strong>{event.title}</strong>
                  <p>
                    {new Date(event.start).toLocaleString()} to{" "}
                    {new Date(event.end).toLocaleString()}
                  </p>
                </div>
                <button type="button" onClick={() => handleDeleteCalendarEvent(event.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Generate Schedule</h2>
          <form onSubmit={handleGenerateSchedule} className="stack">
            <div className="grid two">
              <label>
                Planning horizon (days)
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={planningHorizonDays}
                  onChange={(event) => setPlanningHorizonDays(event.target.value)}
                />
              </label>
              <label>
                Timezone
                <input
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  placeholder="America/Chicago"
                />
              </label>
            </div>
            <label className="check-label">
              <input type="checkbox" checked={useAI} onChange={(event) => setUseAI(event.target.checked)} />
              Use Gemini (falls back to heuristic automatically)
            </label>
            <label>
              Description used for scheduling
              <textarea
                value={scheduleDescription}
                onChange={(event) => setScheduleDescription(event.target.value)}
                rows={4}
                placeholder="Optional override; defaults to saved energy profile."
              />
            </label>
            <button type="submit" disabled={isGeneratingSchedule}>
              {isGeneratingSchedule ? "Generating..." : "Generate Schedule"}
            </button>
          </form>
        </section>
      </div>

      <section className="panel">
        <h2>Generated Schedule</h2>
        {!schedule ? <p className="muted">No schedule generated yet.</p> : null}
        {schedule ? (
          <>
            <p className="muted">
              Strategy: <strong>{schedule.strategy_used}</strong> | Generated:{" "}
              {new Date(schedule.generated_at).toLocaleString()}
            </p>
            <ul className="list">
              {schedule.schedule_events.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{event.title}</strong>
                    <p>
                      {new Date(event.start).toLocaleString()} to{" "}
                      {new Date(event.end).toLocaleString()}
                    </p>
                    <p>
                      task: {event.task_id} | source: {event.source}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <h3>Unscheduled Tasks</h3>
            <ul className="list compact">
              {schedule.unscheduled_tasks.length === 0 ? (
                <li>All tasks scheduled.</li>
              ) : (
                schedule.unscheduled_tasks.map((item) => (
                  <li key={`${item.task_id}_${item.reason}`}>
                    <div>
                      <strong>{item.task_id}</strong>
                      <p>{item.reason}</p>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </>
        ) : null}
      </section>

      <section className="panel">
        <h2>Schedule Check-in</h2>
        <form onSubmit={handleSubmitCheckin} className="stack">
          <label>
            Feedback
            <textarea
              value={checkinFeedback}
              onChange={(event) => setCheckinFeedback(event.target.value)}
              rows={4}
              placeholder="How does the new schedule feel after a few days?"
            />
          </label>
          <label>
            Satisfaction (optional)
            <select
              value={checkinSatisfaction}
              onChange={(event) => setCheckinSatisfaction(event.target.value)}
            >
              <option value="">No rating</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
            </select>
          </label>
          <button type="submit" disabled={isSubmittingCheckin}>
            {isSubmittingCheckin ? "Submitting..." : "Submit Check-in"}
          </button>
        </form>

        <h3>Recent Check-ins</h3>
        <ul className="list compact">
          {checkins.length === 0 ? (
            <li>No check-ins yet.</li>
          ) : (
            checkins
              .slice()
              .reverse()
              .slice(0, 6)
              .map((checkin) => (
                <li key={`${checkin.submitted_at}_${checkin.feedback}`}>
                  <div>
                    <p>{checkin.feedback}</p>
                    <p>
                      {new Date(checkin.submitted_at).toLocaleString()} | rating:{" "}
                      {checkin.satisfaction ?? "n/a"}
                    </p>
                  </div>
                </li>
              ))
          )}
        </ul>
      </section>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unexpected error.";
}

export default App;
