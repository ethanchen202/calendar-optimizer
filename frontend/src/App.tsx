import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiClient } from "./api";
import type {
  CalendarEvent,
  ChatDelta,
  CheckinRecord,
  EnergyProfile,
  ScheduleResponse,
  Task,
  UserState
} from "./types";

const DEFAULT_API_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

type ChatTurn = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

const EMPTY_PROFILE: EnergyProfile = {
  version: 1,
  timezone: DEFAULT_TIMEZONE,
  intervals: [],
  freeform_notes: null,
  updated_at: null
};

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
  const [energyProfile, setEnergyProfile] = useState<EnergyProfile>(EMPTY_PROFILE);
  const [energyProfileInputText, setEnergyProfileInputText] = useState("");
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

  const [planningHorizonDays, setPlanningHorizonDays] = useState("7");
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [useAI, setUseAI] = useState(true);

  const [checkinFeedback, setCheckinFeedback] = useState("");
  const [checkinSatisfaction, setCheckinSatisfaction] = useState("");

  const [chatInput, setChatInput] = useState("");
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [chatEmotions, setChatEmotions] = useState<string[]>([]);
  const [pendingChatDelta, setPendingChatDelta] = useState<ChatDelta | null>(null);
  const [pendingDeltaPreview, setPendingDeltaPreview] = useState<string[]>([]);

  const [isLoadingState, setIsLoadingState] = useState(false);
  const [isSavingTasks, setIsSavingTasks] = useState(false);
  const [isSavingCalendar, setIsSavingCalendar] = useState(false);
  const [isSavingEnergy, setIsSavingEnergy] = useState(false);
  const [isGeneratingSchedule, setIsGeneratingSchedule] = useState(false);
  const [isSubmittingCheckin, setIsSubmittingCheckin] = useState(false);
  const [isAnalyzingChat, setIsAnalyzingChat] = useState(false);
  const [isApplyingChatDelta, setIsApplyingChatDelta] = useState(false);

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

  useEffect(() => {
    void warmupChatModel();
  }, [api]);

  const clearMessages = () => {
    setStatusMessage("");
    setErrorMessage("");
  };

  function requireUserId(): string {
    const trimmed = userId.trim();
    if (!trimmed) {
      throw new Error("User ID is required.");
    }
    return trimmed;
  }

  function applyUserState(state: UserState) {
    setTasks(state.tasks);
    setCalendarEvents(state.calendar_events ?? []);
    setEnergyProfile(state.energy_profile ?? EMPTY_PROFILE);
    setCheckins(state.checkins);
  }

  function pushChatTurn(role: "user" | "assistant", text: string) {
    setChatTurns((current) => [
      ...current,
      {
        role,
        text,
        timestamp: new Date().toISOString()
      }
    ]);
  }

  async function checkBackendHealth() {
    try {
      const health = await api.health();
      setBackendHealth(
        `${health.status} | chat: ${health.chat_ai_provider} | scheduler: ${health.scheduler_strategy}`
      );
    } catch {
      setBackendHealth("offline");
    }
  }

  async function warmupChatModel() {
    try {
      await api.warmupChatAI();
    } catch {
      // Best-effort warmup only. Keep UI responsive if warmup fails.
    }
  }

  async function loadUserState() {
    try {
      clearMessages();
      setIsLoadingState(true);
      const uid = requireUserId();
      const state = await api.getUserState(uid);
      applyUserState(state);
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
      applyUserState(state);
      setStatusMessage(successMessage);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSavingTasks(false);
    }
  }

  async function saveCalendar(nextEvents: CalendarEvent[], successMessage: string) {
    try {
      setIsSavingCalendar(true);
      clearMessages();
      const uid = requireUserId();
      const state = await api.syncCalendar(uid, nextEvents);
      applyUserState(state);
      setStatusMessage(successMessage);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSavingCalendar(false);
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
      clearMessages();
      setIsSavingEnergy(true);
      const uid = requireUserId();
      const description = energyProfileInputText.trim();
      if (!description) {
        throw new Error("Energy profile text update is required.");
      }
      await api.updateEnergyProfile(uid, description);
      setEnergyProfileInputText("");
      await loadUserState();
      setStatusMessage("Energy profile updated and parsed into intervals.");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSavingEnergy(false);
    }
  }

  async function handleAddCalendarEvent(event: FormEvent<HTMLFormElement>) {
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

      const nextEvents = [
        ...calendarEvents,
        {
          id: `event_${Date.now()}`,
          title,
          start: startDate.toISOString(),
          end: endDate.toISOString()
        }
      ];
      await saveCalendar(nextEvents, "Added and synced current calendar event.");
      setEventTitle("");
      setEventStart("");
      setEventEnd("");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }

  async function handleDeleteCalendarEvent(eventId: string | null | undefined) {
    if (!eventId) {
      return;
    }
    const nextEvents = calendarEvents.filter((item) => item.id !== eventId);
    await saveCalendar(nextEvents, "Removed and synced calendar event.");
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
        userDescription: "",
        planningHorizonDays: horizon,
        timezone: timezone.trim() || "UTC",
        useAI: false
      });
      setSchedule(response);
      setStatusMessage("Schedule generated with deterministic heuristic strategy.");
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
      const satisfaction = checkinSatisfaction ? Number.parseInt(checkinSatisfaction, 10) : undefined;
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

  async function handleAnalyzeChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      clearMessages();
      setIsAnalyzingChat(true);
      const uid = requireUserId();
      const message = chatInput.trim();
      if (!message) {
        throw new Error("Chat message cannot be empty.");
      }
      pushChatTurn("user", message);
      setChatInput("");

      const response = await api.analyzeChat({
        userId: uid,
        message,
        timezone,
        useAI
      });

      pushChatTurn("assistant", response.assistant_message);
      setChatEmotions(response.detected_emotions);
      if (response.updated_energy_profile) {
        setEnergyProfile(response.updated_energy_profile);
      }

      if (response.requires_confirmation && hasStructuralDeltaChanges(response.proposed_delta)) {
        setPendingChatDelta(response.proposed_delta);
        setPendingDeltaPreview(response.delta_preview);
        setStatusMessage("Chatbot proposed a delta. Confirm to apply changes.");
      } else {
        setPendingChatDelta(null);
        setPendingDeltaPreview([]);
        setStatusMessage("Chat analyzed and energy profile updated.");
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsAnalyzingChat(false);
    }
  }

  async function handleConfirmDelta() {
    try {
      if (!pendingChatDelta) {
        return;
      }
      clearMessages();
      setIsApplyingChatDelta(true);
      const uid = requireUserId();
      const response = await api.applyChatDelta({ userId: uid, delta: pendingChatDelta });
      applyUserState(response.user_state);
      setPendingChatDelta(null);
      setPendingDeltaPreview([]);
      pushChatTurn("assistant", "Applied confirmed changes.");
      setStatusMessage(response.message);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsApplyingChatDelta(false);
    }
  }

  function handleRejectDelta() {
    setPendingChatDelta(null);
    setPendingDeltaPreview([]);
    setStatusMessage("Pending chatbot delta was discarded.");
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="kicker">Calendar Optimizer</p>
        <h1>Energy-aware planning with structured profile intervals.</h1>
        <p>
          The scheduler now uses only deterministic heuristics over tasks, calendar constraints, and
          the structured energy profile JSON.
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

      <section className="panel">
        <h2>Chatbot</h2>
        <p className="muted">
          Use chat for mood updates and task/calendar edits. Structural changes show a confirmation
          delta before applying.
        </p>
        {chatEmotions.length > 0 ? <p className="muted">Detected emotions: {chatEmotions.join(", ")}</p> : null}

        <div className="chat-log">
          {chatTurns.length === 0 ? (
            <p className="muted">No chat messages yet.</p>
          ) : (
            chatTurns.map((turn) => (
              <div key={`${turn.timestamp}_${turn.role}_${turn.text}`} className={`chat-turn ${turn.role}`}>
                <strong>{turn.role === "user" ? "You" : "Assistant"}</strong>
                <p>{turn.text}</p>
              </div>
            ))
          )}
        </div>

        <form onSubmit={handleAnalyzeChat} className="stack">
          <label>
            Message
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              rows={3}
              placeholder="e.g. I have a test next Monday from 2-4 pm and I will be too tired the rest of the day."
            />
          </label>
          <label className="check-label">
            <input type="checkbox" checked={useAI} onChange={(event) => setUseAI(event.target.checked)} />
            Use Gemini for language understanding
          </label>
          <button type="submit" disabled={isAnalyzingChat}>
            {isAnalyzingChat ? "Analyzing..." : "Send to Chatbot"}
          </button>
        </form>

        {pendingChatDelta ? (
          <div className="delta-box">
            <h3>Pending Delta (Confirm Required)</h3>
            <ul className="list compact">
              {pendingDeltaPreview.length === 0 ? (
                <li>Changes detected but preview is empty.</li>
              ) : (
                pendingDeltaPreview.map((line) => <li key={line}>{line}</li>)
              )}
            </ul>
            <div className="row">
              <button type="button" disabled={isApplyingChatDelta} onClick={() => void handleConfirmDelta()}>
                {isApplyingChatDelta ? "Applying..." : "Confirm Changes"}
              </button>
              <button type="button" className="button-secondary" onClick={handleRejectDelta}>
                Reject
              </button>
            </div>
          </div>
        ) : null}
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
              Energy profile update text
              <textarea
                value={energyProfileInputText}
                onChange={(event) => setEnergyProfileInputText(event.target.value)}
                rows={5}
                placeholder="e.g. I am unusually busy on the 3rd week of every month."
              />
            </label>
            <button type="submit" disabled={isSavingEnergy}>
              {isSavingEnergy ? "Saving..." : "Parse + Merge Into Profile"}
            </button>
          </form>
          <h3>Parsed Intervals ({energyProfile.intervals.length})</h3>
          <ul className="list compact">
            {energyProfile.intervals.length === 0 ? (
              <li>No intervals yet.</li>
            ) : (
              energyProfile.intervals.map((interval) => (
                <li key={interval.id}>
                  <div>
                    <strong>{interval.label ?? interval.id}</strong>
                    <p>
                      {interval.start_time} - {interval.end_time} | level {interval.energy_level} | recurrence{" "}
                      {interval.recurrence.type}
                    </p>
                  </div>
                </li>
              ))
            )}
          </ul>
          <details>
            <summary>View Energy Profile JSON</summary>
            <pre className="json-preview">{JSON.stringify(energyProfile, null, 2)}</pre>
          </details>
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
            <button type="submit" disabled={isSavingCalendar}>
              {isSavingCalendar ? "Saving..." : "Add Calendar Event"}
            </button>
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
                <button type="button" onClick={() => void handleDeleteCalendarEvent(event.id)}>
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
            <p className="muted">Scheduler is deterministic heuristic mode (no AI scheduling).</p>
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

function hasStructuralDeltaChanges(delta: ChatDelta): boolean {
  return Boolean(
    delta.tasks_add.length > 0 ||
      delta.task_ids_remove.length > 0 ||
      delta.task_title_contains_remove.length > 0 ||
      delta.calendar_add.length > 0 ||
      delta.calendar_ids_remove.length > 0 ||
      delta.calendar_title_contains_remove.length > 0
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unexpected error.";
}

export default App;
