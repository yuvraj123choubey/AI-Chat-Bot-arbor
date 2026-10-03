import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, documentTitle, formatDate, ndjsonEvents, openDocumentPreview, UPLOAD_ACCEPT } from "../api.ts";
import { assignmentContext, assignmentsApi, kindLabel, roles, ServiceMissing, type Assignment, type Course, type Requirement, type RequirementKind } from "../assignments.ts";
import { projectsApi } from "../projects.ts";
import { ArrowIcon, CodeIcon, FileIcon, GridIcon, PlusIcon } from "./Icons.tsx";
import "../files.css";

const statusLabel: Record<Assignment["status"], string> = { not_started: "Not started", in_progress: "In progress", submitted: "Submitted", graded: "Graded" };
const checkLabel = { met: "Met", partial: "Partly met", missing: "Missing", unclear: "Unclear" } as const;

/** Waits for a background task (extraction, submission check) to finish. */
async function waitForTask(taskId: string, onProgress: (label: string) => void): Promise<{ status: string; error?: string }> {
  const res = await api.taskEvents(taskId, new AbortController().signal);
  for await (const e of ndjsonEvents(res)) {
    if (e.type === "progress" && e.label) onProgress(e.detail ? `${e.label} · ${e.detail}` : e.label);
    if ((e.type === "status" || e.type === "snapshot") && ["completed", "failed", "cancelled"].includes(e.status)) return { status: e.status, error: e.error ?? undefined };
  }
  return { status: "completed" };
}

export function Assignments({ onOpenCode }: { onOpenCode(projectId: string, context: string): void }) {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [list, setList] = useState<Assignment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [missing, setMissing] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { const [c, a] = await Promise.all([assignmentsApi.courses(), assignmentsApi.list()]); setCourses(c); setList(a); setMissing(""); }
    catch (e) { if (e instanceof ServiceMissing) setMissing(e.message); else setError(e instanceof Error ? e.message : "Couldn't load assignments."); setCourses(c => c ?? []); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  if (selected) return <AssignmentView id={selected} courses={courses ?? []} onBack={() => { setSelected(null); void refresh(); }} onOpenCode={onOpenCode} />;
  return <section className="library assignments">
    <div className="eyebrow">ASSIGNMENTS</div>
    <h2>Assignments</h2>
    <p className="lede">Keep each assignment's instructions, rubric, lectures and starter code together. Arbor extracts the requirements word for word from your instructions and rubric, tracks your progress, and checks a draft against them before you submit.</p>
    {missing && <div className="setup-note">{missing} The page will work as soon as it is available; nothing you enter is lost.</div>}
    {error && <div className="error" role="alert">{error}</div>}
    {!missing && courses && <NewAssignment courses={courses} onCourse={c => setCourses(cs => [...(cs ?? []), c])} onCreated={a => { setList(l => [a, ...l]); setSelected(a.id); }} />}
    {courses && courses.map(c => {
      const mine = list.filter(a => a.courseId === c.id);
      return <div key={c.id} className="course-block">
        <div className="nav-label">{c.code ? `${c.code} · ` : ""}{c.name}{c.term ? ` · ${c.term}` : ""}</div>
        {!mine.length && <p className="tree-empty">No assignments yet.</p>}
        <div className="research-list">{mine.map(a => <button key={a.id} type="button" className="research-item assignment-item" onClick={() => setSelected(a.id)}>
          <span className="research-item-q"><GridIcon size={13} /> {a.title}</span>
          <span className="progress-mini" title={`${a.progress.done} of ${a.progress.total} requirements done`}><span style={{ width: `${a.progress.total ? (100 * a.progress.done) / a.progress.total : 0}%` }} /></span>
          <small>{a.dueAt ? `Due ${formatDate(a.dueAt)}` : statusLabel[a.status]}</small>
        </button>)}</div>
      </div>;
    })}
  </section>;
}

function NewAssignment({ courses, onCourse, onCreated }: { courses: Course[]; onCourse(c: Course): void; onCreated(a: Assignment): void }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [courseName, setCourseName] = useState("");
  const [courseCode, setCourseCode] = useState("");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!courseId && courses[0]) setCourseId(courses[0].id); }, [courses, courseId]);
  async function addCourse() {
    if (!courseName.trim()) return;
    try { const c = await assignmentsApi.createCourse({ name: courseName.trim(), code: courseCode.trim() || undefined }); onCourse(c); setCourseId(c.id); setCourseName(""); setCourseCode(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't create the course."); }
  }
  async function create() {
    if (!courseId || !title.trim()) return;
    setBusy(true); setError("");
    try { onCreated(await assignmentsApi.create({ courseId, title: title.trim(), dueAt: due ? new Date(due).toISOString() : undefined })); setTitle(""); setDue(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't create the assignment."); } finally { setBusy(false); }
  }
  return <div className="glass new-project">
    <div className="form-row"><strong>New course</strong>
      <input value={courseCode} onChange={e => setCourseCode(e.target.value)} placeholder="Code (e.g. CPRE 4300)" aria-label="Course code" className="short" />
      <input value={courseName} onChange={e => setCourseName(e.target.value)} placeholder="Course name" aria-label="Course name" onKeyDown={e => { if (e.key === "Enter") void addCourse(); }} />
      <button type="button" className="chip" disabled={!courseName.trim()} onClick={addCourse}><PlusIcon size={12} /> Add course</button>
    </div>
    {courses.length > 0 && <div className="form-row"><strong>New assignment</strong>
      <select value={courseId} onChange={e => setCourseId(e.target.value)} aria-label="Course">{courses.map(c => <option key={c.id} value={c.id}>{c.code ? `${c.code} · ` : ""}{c.name}</option>)}</select>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Assignment title" aria-label="Assignment title" onKeyDown={e => { if (e.key === "Enter") void create(); }} />
      <input type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Due date" className="short" />
      <button type="button" className="send" disabled={!title.trim() || busy} onClick={create}>Create <ArrowIcon size={13} /></button>
    </div>}
    {error && <div className="error" role="alert">{error}</div>}
  </div>;
}

function AssignmentView({ id, courses, onBack, onOpenCode }: { id: string; courses: Course[]; onBack(): void; onOpenCode(projectId: string, context: string): void }) {
  const [a, setA] = useState<Assignment | null>(null);
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [uploadRole, setUploadRole] = useState("instructions");
  const fileInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try { const [assignment, r] = await Promise.all([assignmentsApi.get(id), assignmentsApi.requirements(id)]); setA(assignment); setReqs(r.requirements); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load the assignment."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // Uploaded files are processed in the background; the list refreshes until they are ready.
  useEffect(() => {
    if (!a?.documents?.some(d => d.status === "processing")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [a, load]);
  const course = courses.find(c => c.id === a?.courseId);
  const byKind = useMemo(() => {
    const groups = new Map<RequirementKind, Requirement[]>();
    for (const r of reqs) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
    return [...groups];
  }, [reqs]);
  const done = reqs.filter(r => r.status === "done").length;
  const checked = reqs.some(r => r.check);
  const missingCount = reqs.filter(r => r.check && r.check.status !== "met").length;
  const docs = a?.documents ?? [];
  const sourceDocs = docs.filter(d => ["instructions", "rubric"].includes(d.role ?? ""));
  const submissions = docs.filter(d => d.role === "submission" && d.status === "ready");

  async function upload(files: File[]) {
    const role = roles.find(r => r.id === uploadRole)!;
    for (const f of files) {
      setBusy(`Uploading ${f.name}…`);
      try { await api.uploadDocument(f, { kind: role.kind, assignmentId: id, role: role.id }); } catch (e) { setError(e instanceof Error ? e.message : `Couldn't upload ${f.name}`); }
    }
    setBusy("");
    await load();
  }
  async function runTask(start: () => Promise<{ taskId: string }>, label: string) {
    setError(""); setBusy(label);
    try {
      const { taskId } = await start();
      const result = await waitForTask(taskId, l => setBusy(`${label} · ${l}`));
      if (result.status !== "completed") setError(result.error ?? `${label} did not complete.`);
    } catch (e) { setError(e instanceof Error ? e.message : `${label} failed.`); }
    setBusy("");
    await load();
  }
  async function setStatus(r: Requirement, status: Requirement["status"]) {
    setReqs(list => list.map(x => (x.id === r.id ? { ...x, status } : x)));
    try { await assignmentsApi.setRequirement(id, r.id, status); } catch { void load(); }
  }
  /** Copies the starter code files into a new Code Workspace project and opens it with the assignment as context. */
  async function openStarterCode() {
    if (!a) return;
    const starter = docs.filter(d => d.role === "starter_code");
    setBusy("Preparing the code project…");
    try {
      const project = await projectsApi.create(`${a.title}`.slice(0, 100), "blank");
      for (const d of starter) {
        const bytes = new Uint8Array(await (await fetch(`/api/documents/${d.id}/file`)).arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await projectsApi.writeBase64(project.id, d.name, btoa(binary));
        await api.linkDocument(d.id, "project", project.id, "starter_code").catch(() => {});
      }
      await projectsApi.checkpoint(project.id, "Starter code from the assignment").catch(() => {});
      onOpenCode(project.id, assignmentContext(a, reqs));
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't create the project."); }
    setBusy("");
  }
  const linkedProject = docs.flatMap(d => d.links ?? []).find(l => l.type === "project");

  if (!a) return <section className="library">{error ? <div className="error" role="alert">{error}</div> : <p className="thinking">Loading…</p>}</section>;
  return <section className="library assignment-view">
    <button type="button" className="back-link" onClick={onBack}>← All assignments</button>
    <div className="research-head">
      <div className="eyebrow">{course ? `${course.code ? `${course.code} · ` : ""}${course.name}` : "ASSIGNMENT"}</div>
      <h2>{a.title}</h2>
      <div className="research-head-meta">
        <select value={a.status} onChange={async e => setA(await assignmentsApi.update(id, { status: e.target.value as Assignment["status"] }))} aria-label="Status">{Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {a.dueAt && <small>Due {formatDate(a.dueAt)}</small>}
        <small>{reqs.length ? `${done} / ${reqs.length} requirements done` : "No requirements extracted yet"}</small>
      </div>
      {reqs.length > 0 && <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={reqs.length} aria-valuenow={done}><span style={{ width: `${(100 * done) / reqs.length}%` }} /></div>}
    </div>
    {busy && <div className="setup-note" role="status">{busy}</div>}
    {error && <div className="error" role="alert">{error}</div>}

    <div className="assignment-grid">
      <div className="glass panel-block">
        <div className="block-head"><span className="nav-label">FILES</span>
          <select value={uploadRole} onChange={e => setUploadRole(e.target.value)} aria-label="Upload as">{roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
          <button type="button" className="chip" onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}><PlusIcon size={12} /> Upload</button>
          <input ref={fileInput} type="file" multiple accept={UPLOAD_ACCEPT} hidden onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void upload(f); }} />
        </div>
        {!docs.length && <p className="tree-empty">Upload the assignment instructions and rubric first; requirements are extracted from them.</p>}
        {docs.map(d => <div key={d.linkId} className="assignment-file">
          <FileIcon size={13} />
          <button type="button" className="file-name" onClick={() => openDocumentPreview(d.id)} disabled={d.status !== "ready"}>{documentTitle(d)}</button>
          <span className="tag">{roles.find(r => r.id === d.role)?.label ?? d.role ?? "File"}</span>
          {d.status !== "ready" && <span className={`research-badge ${d.status === "processing" ? "running" : "failed"}`}>{d.status}</span>}
        </div>)}
        <div className="block-actions">
          <button type="button" className="send" disabled={!sourceDocs.some(d => d.status === "ready") || Boolean(busy)} onClick={() => runTask(() => assignmentsApi.extract(id), "Extracting requirements")}>{a.extractedAt ? "Re-extract requirements" : "Extract requirements"}</button>
          {docs.some(d => d.role === "starter_code") && <button type="button" className="chip" disabled={Boolean(busy)} onClick={openStarterCode}><CodeIcon size={12} /> Open starter code</button>}
          {linkedProject && <button type="button" className="chip" onClick={() => onOpenCode(linkedProject.targetId, assignmentContext(a, reqs))}><CodeIcon size={12} /> Open code project</button>}
        </div>
      </div>

      <div className="glass panel-block">
        <div className="block-head"><span className="nav-label">SUBMISSION CHECK</span></div>
        {!submissions.length ? <p className="tree-empty">Upload your draft with "Submission" selected, then check it against every requirement.</p>
          : <div className="block-actions">{submissions.map(s => <button key={s.id} type="button" className="chip" disabled={!reqs.length || Boolean(busy)} onClick={() => runTask(() => assignmentsApi.check(id, s.id), `Checking ${documentTitle(s)}`)}>Check {documentTitle(s)}</button>)}</div>}
        {checked && <div className={`check-summary ${missingCount ? "bad" : "ok"}`}><strong>{missingCount ? "Not ready" : "Ready"}</strong><small>{missingCount ? `${missingCount} requirement${missingCount === 1 ? "" : "s"} not fully met` : "Every requirement was found in the draft"}{a.checkedAt ? ` · checked ${formatDate(a.checkedAt)}` : ""}</small></div>}
      </div>
    </div>

    {byKind.map(([kind, items]) => <div key={kind} className="glass panel-block">
      <div className="block-head"><span className="nav-label">{kindLabel[kind].toUpperCase()}</span><small>{items.filter(r => r.status === "done").length} / {items.length}</small></div>
      <ol className="requirements">{items.map(r => <li key={r.id} className={r.status}>
        <button type="button" className="req-box" aria-label={`Mark ${r.status === "done" ? "not done" : "done"}`} onClick={() => setStatus(r, r.status === "done" ? "todo" : "done")}>{r.status === "done" ? "✓" : r.status === "in_progress" ? "◌" : ""}</button>
        <div className="req-main">
          <span className="req-text">{r.text}{r.points !== null && <span className="tag">{r.points} pts</span>}</span>
          <button type="button" className="req-quote" onClick={() => openDocumentPreview(r.documentId, r.page ? { page: r.page } : r.section ? { section: r.section } : undefined)} title="Open the source">“{r.quote}” <small>— {r.documentName}{r.page ? `, p. ${r.page}` : r.section ? `, ${r.section}` : ""}</small></button>
          {r.check && <div className={`req-check ${r.check.status}`}><strong>{checkLabel[r.check.status]}</strong> {r.check.note}{r.check.quote && <em> “{r.check.quote}”</em>}</div>}
        </div>
      </li>)}</ol>
    </div>)}
  </section>;
}
