import { mkdir, rm } from "node:fs/promises";
import type { Db } from "../../../../packages/db/src/client.ts";
import { CommandRunner, Previews, ProjectFiles, ProjectHistory, detectProject, historyDir, projectDir, runsDir, templates } from "../../../../packages/code/src/index.ts";

export interface ProjectView { id: string; name: string; template: string | null; createdAt: string; kind: string; label: string; testCommand?: string; buildCommand?: string }
export interface ProjectHandle { id: string; name: string; root: string; files: ProjectFiles; history: ProjectHistory }

/**
 * Coding projects: metadata in the database, working files on local disk under data/projects/<id>, version history
 * in a separate Git directory. Storage is a folder per project, so another backend (object storage, a remote
 * workspace) can replace it behind this class.
 */
export class ProjectService {
  readonly runner: CommandRunner;
  readonly previews: Previews;
  constructor(private readonly db: Db, private readonly dataRoot: string) {
    this.runner = new CommandRunner(id => runsDir(dataRoot, id));
    this.previews = new Previews(this.runner);
  }

  async list(workspaceId: string): Promise<ProjectView[]> {
    const rows = await this.db.project.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
    return Promise.all(rows.map(r => this.view(r)));
  }
  async create(workspaceId: string, name: string, template: string): Promise<ProjectView> {
    const files = templates[template] ? templates[template].files : templates.blank.files;
    const row = await this.db.project.create({ data: { workspaceId, name, rootPath: "", template: templates[template] ? template : "blank" } });
    const root = projectDir(this.dataRoot, row.id);
    await mkdir(root, { recursive: true });
    const handle = this.handleFor(row.id, row.name, root);
    for (const [path, content] of Object.entries(files)) await handle.files.write(path, content);
    await handle.history.checkpoint(`Created project from the ${templates[row.template!]?.label ?? "empty"} template`, "system");
    const saved = await this.db.project.update({ where: { id: row.id }, data: { rootPath: root } });
    return this.view(saved);
  }
  /** The project's files and history, or undefined if it is not in this workspace. */
  async open(workspaceId: string, id: string): Promise<ProjectHandle | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = await this.db.project.findFirst({ where: { id, workspaceId } });
    return row ? this.handleFor(row.id, row.name, row.rootPath || projectDir(this.dataRoot, row.id)) : undefined;
  }
  async get(workspaceId: string, id: string): Promise<ProjectView | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = await this.db.project.findFirst({ where: { id, workspaceId } });
    return row ? this.view(row) : undefined;
  }
  async rename(workspaceId: string, id: string, name: string): Promise<boolean> {
    return (await this.db.project.updateMany({ where: { id, workspaceId }, data: { name } })).count > 0;
  }
  async remove(workspaceId: string, id: string): Promise<boolean> {
    const handle = await this.open(workspaceId, id);
    if (!handle) return false;
    this.previews.stop(id);
    this.runner.stopAll(id);
    await this.db.project.delete({ where: { id } });
    await rm(handle.root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    await rm(historyDir(this.dataRoot, id), { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    return true;
  }
  private handleFor(id: string, name: string, root: string): ProjectHandle {
    return { id, name, root, files: new ProjectFiles(root), history: new ProjectHistory(root, historyDir(this.dataRoot, id)) };
  }
  private async view(row: { id: string; name: string; template: string | null; createdAt: Date; rootPath: string }): Promise<ProjectView> {
    const detected = await detectProject(row.rootPath || projectDir(this.dataRoot, row.id)).catch(() => ({ kind: "unknown", label: "Files" } as const));
    return { id: row.id, name: row.name, template: row.template, createdAt: row.createdAt.toISOString(), kind: detected.kind, label: detected.label, testCommand: "testCommand" in detected ? detected.testCommand : undefined, buildCommand: "buildCommand" in detected ? detected.buildCommand : undefined };
  }
}
