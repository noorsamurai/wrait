import { useMemo, useState } from "react";
import type { Task, User, UserId } from "@lokalen/protocol";
import { sortTasks } from "@lokalen/protocol";
import { CheckIcon, PlusIcon, TrashIcon, ArrowDownIcon, ArrowUpIcon, CloseIcon } from "./icons";

const dayFormat = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short" });

/** Swedish, deliberately relative near today - that is what people scan for. */
function dueLabel(dueAt: number | null): { text: string; tone: "late" | "today" | "soon" | "none" } {
  if (dueAt === null) return { text: "Inget datum", tone: "none" };

  const now = new Date();
  const due = new Date(dueAt);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() - startOfToday) / 86_400_000);

  if (days < 0) return { text: days === -1 ? "I går" : `${Math.abs(days)} dagar sen`, tone: "late" };
  if (days === 0) return { text: "I dag", tone: "today" };
  if (days === 1) return { text: "I morgon", tone: "soon" };
  if (days < 7) return { text: `Om ${days} dagar`, tone: "soon" };
  return { text: dayFormat.format(due), tone: "none" };
}

/** `<input type="date">` wants a local yyyy-mm-dd string, not an ISO instant. */
function toDateInput(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** `days` from today, as the value the date input expects. */
function daysFromNow(days: number): string {
  const when = new Date();
  when.setDate(when.getDate() + days);
  return toDateInput(when);
}

interface TaskPanelProps {
  self: User;
  users: User[];
  tasks: Task[];
  onAdd: (input: { title: string; dueAt?: number | null; owner?: UserId }) => void;
  onClear: (id: string, cleared: boolean) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function TaskPanel({ self, users, tasks, onAdd, onClear, onDelete, onClose }: TaskPanelProps) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState<UserId>(self.id);
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  /**
   * Cleared tasks stay on screen by default, struck through at the bottom.
   *
   * Hiding them the instant they are ticked gives no feedback that anything
   * happened and makes an accidental tick impossible to undo; `sortTasks`
   * already sinks them below everything still open, so they cost nothing.
   */
  const [showCleared, setShowCleared] = useState(true);

  const nameOf = (id: UserId) =>
    id === self.id ? "du" : users.find((u) => u.id === id)?.displayName ?? "någon";

  const visible = useMemo(() => {
    const relevant = tasks.filter((t) => (showCleared ? true : !t.clearedAt));
    return sortTasks(relevant, direction);
  }, [tasks, direction, showCleared]);

  const openCount = tasks.filter((t) => t.owner === self.id && !t.clearedAt).length;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    onAdd({
      title: text,
      // A date-only input means "some time that day", so anchor it to midday
      // rather than midnight - nobody means 00:00 when they pick a day.
      dueAt: due ? new Date(`${due}T12:00`).getTime() : null,
      owner,
    });
    setTitle("");
    setDue("");
    // Reset the recipient too. Leaving it pointed at a colleague means the
    // next task you type silently goes to them as well, which is how a
    // private note ends up in someone else's list.
    setOwner(self.id);
  }

  return (
    <aside className="surface tasks">
      <div className="tasks__head">
        <h2 className="tasks__title">Att göra</h2>
        {openCount > 0 ? <span className="badge">{openCount}</span> : null}
        <button
          className="btn btn--icon"
          onClick={() => setDirection((d) => (d === "asc" ? "desc" : "asc"))}
          title={direction === "asc" ? "Äldsta datum först" : "Senaste datum först"}
          aria-label="Byt sortering"
        >
          {direction === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}
        </button>
        <button className="btn btn--icon" onClick={onClose} aria-label="Stäng uppgifter">
          <CloseIcon />
        </button>
      </div>

      <form className="tasks__new" onSubmit={submit}>
        <input
          className="field"
          placeholder="Vad behöver göras?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Ny uppgift"
        />
        {/*
          Most tasks are due today or tomorrow, and the native date field
          renders in the operating system's format - which is not Swedish on
          an English Windows. These cover the common cases without anyone
          having to read a date format at all.
        */}
        <div className="tasks__quick">
          {[
            { label: "I dag", value: daysFromNow(0) },
            { label: "I morgon", value: daysFromNow(1) },
            { label: "Nästa vecka", value: daysFromNow(7) },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              className="chip"
              aria-pressed={due === option.value}
              onClick={() => setDue(due === option.value ? "" : option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="tasks__new-row">
          <input
            className="field"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Datum"
          />
          <select
            className="field"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            aria-label="Till vem"
          >
            <option value={self.id}>Till mig</option>
            {users
              .filter((u) => u.id !== self.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  Till {u.displayName}
                </option>
              ))}
          </select>
          <button className="btn btn--primary btn--icon" type="submit" disabled={!title.trim()} aria-label="Lägg till">
            <PlusIcon />
          </button>
        </div>
      </form>

      <div className="tasks__list">
        {visible.length === 0 ? (
          <p className="tasks__empty">
            {showCleared ? "Inget här ännu." : "Inga öppna uppgifter."}
          </p>
        ) : (
          visible.map((task) => {
            const due = dueLabel(task.dueAt);
            const mine = task.owner === self.id;
            const cleared = Boolean(task.clearedAt);
            return (
              <div key={task.id} className="task" data-cleared={cleared}>
                <button
                  className="task__check"
                  aria-pressed={cleared}
                  aria-label={cleared ? "Ångra klarmarkering" : "Markera som klar"}
                  onClick={() => onClear(task.id, !cleared)}
                >
                  {cleared ? <CheckIcon size={13} /> : null}
                </button>

                <div className="task__body">
                  <div className="task__title">{task.title}</div>
                  <div className="task__meta">
                    <span className="task__due" data-tone={due.tone}>
                      {due.text}
                    </span>
                    {/* Who is involved only matters when it is not just you. */}
                    {task.createdBy !== task.owner ? (
                      <span>
                        {mine
                          ? `från ${nameOf(task.createdBy)}`
                          : `till ${nameOf(task.owner)}`}
                      </span>
                    ) : null}
                    {task.sourceMessageId ? <span>sparat meddelande</span> : null}
                  </div>
                </div>

                <button
                  className="btn btn--icon task__delete"
                  onClick={() => onDelete(task.id)}
                  aria-label="Ta bort uppgift"
                >
                  <TrashIcon size={15} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="tasks__foot">
        <button className="tasks__toggle" onClick={() => setShowCleared((v) => !v)}>
          {showCleared ? "Dölj klara" : "Visa klara"}
        </button>
      </div>
    </aside>
  );
}
