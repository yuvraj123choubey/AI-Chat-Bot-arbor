import { WORKSPACE, type DocumentView } from "./api.ts";

export type Course = { id: string; name: string; code: string | null; term: string | null; instructor: string | null; createdAt: string; assignmentCount: number };
export type AssignmentStatus = "not_started" | "in_progress" | "submitted" | "graded";
export type AssignmentDoc = DocumentView & { linkId: string; role: string | null };
export type Assignment = {
  id: string; courseId: string; title: string; dueAt: string | null; status: AssignmentStatus; notes: string | null; description: string | null;
  extractedAt: string | null; checkedAt: string | null; createdAt: string; updatedAt: string; documents?: AssignmentDoc[]; progress: { total: number; done: number };
};
export type RequirementKind = "requirement" | "deliverable" | "rubric_criterion" | "citation_rule" | "formatting" | "deadline";
export type Requirement = {
  id: string; kind: RequirementKind; text: string; quote: string; documentId: string; documentName: string; page: number | null; section: string | null; points: number | null;
  status: "todo" | "in_progress" | "done"; ordinal: number; check: null | { status: "met" | "partial" | "missing" | "unclear"; note: string; quote: string | null };
};
export const roles: { id: string; label: string; kind: string }[] = [
  { id: "instructions", label: "Instructions", kind: "assignment_instructions" }, { id: "rubric", label: "Rubric", kind: "rubric" },
  { id: "lecture", label: "Lecture", kind: "lecture" }, { id: "starter_code", label: "Starter code", kind: "starter_code" },
  { id: "screenshot", label: "Screenshot", kind: "screenshot" }, { id: "reference", label: "Reference", kind: "course_material" }, { id: "submission", label: "Submission", kind: "upload" }
];
export const kindLabel: Record<RequirementKind, string> = { requirement: "Requirements", deliverable: "Deliverables", rubric_criterion: "Rubric criteria", citation_rule: "Citation rules", formatting: "Formatting", deadline: "Deadlines" };

/** Raised when the assignments service is not available on this server (rather than a real error). */
export class ServiceMissing extends Error {}
const q = `workspaceId=${WORKSPACE}`;
const json = { "content-type": "application/json" };
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 && data.error === "Not found") throw new ServiceMissing("The assignments service isn't running on this server yet.");
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
export const assignmentsApi = {
  courses: () => call<Course[]>(`/api/courses?${q}`),
  createCourse: (c: { name: string; code?: string; term?: string; instructor?: string }) => call<Course>(`/api/courses?${q}`, { method: "POST", headers: json, body: JSON.stringify(c) }),
  deleteCourse: (id: string) => call(`/api/courses/${id}?${q}`, { method: "DELETE" }),
  list: (courseId?: string) => call<Assignment[]>(`/api/assignments?${q}${courseId ? `&courseId=${courseId}` : ""}`),
  get: (id: string) => call<Assignment>(`/api/assignments/${id}?${q}`),
  create: (a: { courseId: string; title: string; dueAt?: string; description?: string }) => call<Assignment>(`/api/assignments?${q}`, { method: "POST", headers: json, body: JSON.stringify(a) }),
  update: (id: string, patch: Partial<Pick<Assignment, "title" | "dueAt" | "status" | "notes" | "description">>) => call<Assignment>(`/api/assignments/${id}?${q}`, { method: "PATCH", headers: json, body: JSON.stringify(patch) }),
  remove: (id: string) => call(`/api/assignments/${id}?${q}`, { method: "DELETE" }),
  extract: (id: string) => call<{ taskId: string }>(`/api/assignments/${id}/extract?${q}`, { method: "POST", headers: json, body: "{}" }),
  requirements: (id: string) => call<{ requirements: Requirement[]; extractedAt: string | null; checkedAt: string | null }>(`/api/assignments/${id}/requirements?${q}`),
  setRequirement: (id: string, reqId: string, status: Requirement["status"]) => call<Requirement>(`/api/assignments/${id}/requirements/${reqId}?${q}`, { method: "PATCH", headers: json, body: JSON.stringify({ status }) }),
  check: (id: string, documentId: string) => call<{ taskId: string }>(`/api/assignments/${id}/check?${q}`, { method: "POST", headers: json, body: JSON.stringify({ documentId }) })
};

/** What the coding agent should know about an assignment: its title and the requirements quoted from the instructions. */
export function assignmentContext(a: Assignment, reqs: Requirement[]): string {
  const lines = reqs.map(r => `- [${kindLabel[r.kind]}] ${r.text}${r.page ? ` (${r.documentName} p. ${r.page})` : ""}`);
  return [`Assignment: ${a.title}`, a.description ? `Description: ${a.description}` : "", lines.length ? `Requirements extracted from the instructions and rubric:\n${lines.join("\n")}` : "No requirements have been extracted yet."].filter(Boolean).join("\n");
}
