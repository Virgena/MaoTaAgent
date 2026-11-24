import { useCallback, useEffect, useState } from "react";

import { call } from "../lib/rpc.ts";

interface Job {
  id: string;
  kind: string;
  label: string;
  status: string;
  progress?: string;
}

interface Schedule {
  id: string;
  title: string;
  mode: string;
  enabled: boolean;
  next_at: string | null;
  run_count: number;
  last_status?: string;
}

export function TasksView({ session }: { session: { id: string; cwd: string } | null }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [title, setTitle] = useState("Scheduled task");
  const [prompt, setPrompt] = useState("Check the current state and report what changed.");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const jobReply = session === null
        ? { jobs: [] as Job[] }
        : await call<{ jobs?: Job[] }>("jobs.list", { session_id: session.id });
      setJobs(jobReply.jobs ?? []);
      const scheduleReply = await call<{ schedules?: Schedule[] }>("schedules.list");
      setSchedules(scheduleReply.schedules ?? []);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [session]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const create = async (): Promise<void> => {
    if (session === null) return;
    try {
      await call("schedules.create", {
        session_id: session.id,
        cwd: session.cwd,
        data: {
          title,
          mode: "remind",
          prompt,
          schedule_kind: "cron",
          cron,
          timezone,
          permission: "ask",
        },
      });
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div style={{ padding: 24, overflow: "auto", height: "100%" }}>
      <h2 style={{ marginTop: 0 }}>Tasks</h2>
      {error === null ? null : <p style={{ color: "var(--danger)" }}>{error}</p>}
      <h3>Background jobs</h3>
      {jobs.length === 0 ? (
        <p>(no background jobs)</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {jobs.map((job) => (
            <div key={job.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
              <strong>{job.id}</strong> [{job.kind}] {job.status}
              <div>{job.label}</div>
              {job.progress ? <small>{job.progress}</small> : null}
              <div style={{ marginTop: 8 }}>
                <button type="button" onClick={() => void call("jobs.kill", { session_id: session?.id ?? "", id: job.id, reason: "Web request" }).then(refresh)}>
                  Stop
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Schedules</h3>
      <div style={{ display: "grid", gap: 8 }}>
        {schedules.map((schedule) => (
          <div key={schedule.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
            <strong>{schedule.title}</strong> [{schedule.mode}] {schedule.enabled ? "active" : "paused"}
            <div>{schedule.next_at ?? "ended"} · {schedule.run_count} runs {schedule.last_status ? `· ${schedule.last_status}` : ""}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" onClick={() => void call("schedules.run", { id: schedule.id }).then(refresh)}>Run now</button>
              <button type="button" onClick={() => void call("schedules.update", { id: schedule.id, enabled: !schedule.enabled }).then(refresh)}>
                {schedule.enabled ? "Pause" : "Resume"}
              </button>
              <button type="button" onClick={() => void call("schedules.delete", { id: schedule.id }).then(refresh)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: 24 }}>New reminder</h3>
      <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Prompt" rows={4} />
        <input value={cron} onChange={(event) => setCron(event.target.value)} placeholder="Cron expression" />
        <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="IANA timezone" />
        <button type="button" disabled={session === null} onClick={() => void create()}>Create reminder</button>
      </div>
    </div>
  );
}
