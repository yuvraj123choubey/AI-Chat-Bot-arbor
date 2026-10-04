import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import busboy from "busboy";
import { detectFileType, previewDocument, UnsupportedFileError } from "../../../../packages/files/src/index.ts";
import type { App } from "../app.ts";
import { readJson, send, type RouteContext } from "../http.ts";
import { parseWorkspace } from "./chat.ts";
import { toDocumentView, type LinkTarget } from "../repos/documents.ts";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface Received { tempFile: string; name: string; size: number; sha256: string }
class UploadError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

/** Streams one multipart "file" field to a temporary file, hashing it and enforcing the size limit as it arrives. */
function receive(ctx: RouteContext, tmpDir: string): Promise<Received> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try { parser = busboy({ headers: ctx.req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 5 } }); }
    catch { return reject(new UploadError(400, "Upload must be multipart/form-data with a \"file\" field.")); }
    let received: Promise<Received> | undefined;
    parser.on("file", (field, stream, info) => {
      if (field !== "file") { stream.resume(); return; }
      const tempFile = join(tmpDir, randomUUID());
      const hash = createHash("sha256");
      let size = 0;
      let truncated = false;
      stream.on("limit", () => { truncated = true; });
      received = new Promise((done, fail) => {
        const out = createWriteStream(tempFile);
        stream.on("data", (chunk: Buffer) => { size += chunk.length; hash.update(chunk); });
        stream.pipe(out);
        out.on("finish", () => truncated ? fail(new UploadError(413, "Files can be at most 25 MB.")) : done({ tempFile, name: info.filename || "upload", size, sha256: hash.digest("hex") }));
        out.on("error", fail);
      });
      received.catch(() => rm(tempFile, { force: true }));
    });
    parser.on("error", () => reject(new UploadError(400, "The upload could not be read.")));
    parser.on("close", () => received ? received.then(resolve, reject) : reject(new UploadError(400, "No \"file\" field in the upload.")));
    ctx.req.pipe(parser);
  });
}

/** Uploaded files: upload, list, fetch, download the original, delete. */
export function documentRoutes(app: App) {
  const workspaceOf = async (value: string | null) => {
    const slug = parseWorkspace(value ?? undefined);
    return slug ? app.workspace(slug) : undefined;
  };
  return {
    async upload(ctx: RouteContext) {
      const workspaceId = await workspaceOf(ctx.query.get("workspaceId"));
      if (!workspaceId) return send(ctx.res, 400, { error: "Invalid workspace" });
      const tmpDir = join(app.documents.absolutePath("tmp"));
      await mkdir(tmpDir, { recursive: true });
      let file: Received;
      try { file = await receive(ctx, tmpDir); }
      catch (error) { return send(ctx.res, error instanceof UploadError ? error.status : 400, { error: error instanceof Error ? error.message : "Upload failed" }); }
      try {
        const existing = await app.documents.findBySha(workspaceId, file.sha256);
        if (existing) {
          await rm(file.tempFile, { force: true });
          // Text recognition improves over time and is cheap, so an image uploaded again is read again.
          if (existing.mimeType.startsWith("image/") && existing.status !== "processing") {
            await app.db.document.update({ where: { id: existing.id }, data: { status: "processing", error: null } });
            const taskId = await app.tasks.submit({ workspaceId, userId: app.identity.userId, type: "document_ingest", title: `Read ${existing.name} again`, input: { documentId: existing.id } });
            return send(ctx.res, 202, { document: { ...existing, status: "processing" }, taskId });
          }
          return send(ctx.res, 200, { document: existing, taskId: null });
        }
        let type;
        try { type = detectFileType(file.name, await readFile(file.tempFile)); }
        catch (error) { await rm(file.tempFile, { force: true }); return send(ctx.res, 415, { error: error instanceof UnsupportedFileError ? error.message : "Unsupported file." }); }
        const storagePath = app.documents.storagePath(file.sha256, type.extension);
        await app.documents.store(file.tempFile, storagePath);
        const name = file.name.replace(/[\\/]/g, "_").slice(0, 255);
        const document = await app.documents.create({ workspaceId, name, mimeType: type.mimeType, sizeBytes: file.size, sha256: file.sha256, storagePath });
        const taskId = await app.tasks.submit({ workspaceId, userId: app.identity.userId, type: "document_ingest", title: `Index ${name}`, input: { documentId: document.id } });
        return send(ctx.res, 202, { document, taskId });
      } finally { await rm(file.tempFile, { force: true }); }
    },
    /** ?q= name search, ?kind=, ?status=, ?linked=<conversation|research|assignment|project>:<id> */
    async list({ res, query }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      if (!workspaceId) return send(res, 400, { error: "Invalid workspace" });
      const linked = query.get("linked")?.match(/^(conversation|research|assignment|project):([0-9a-f-]{36})$/);
      if (query.get("linked") && !linked) return send(res, 400, { error: "linked must look like assignment:<id>" });
      return send(res, 200, await app.documents.list(workspaceId, {
        q: query.get("q")?.trim().slice(0, 200) || undefined, kind: query.get("kind") || undefined, status: query.get("status") || undefined,
        linked: linked ? { type: linked[1] as LinkTarget, id: linked[2] } : undefined
      }));
    },
    async rename({ req, res, query, params }: RouteContext) {
      const body = await readJson(req);
      const name = body.displayName === null ? null : typeof body.displayName === "string" ? body.displayName.trim().slice(0, 200) || null : undefined;
      if (name === undefined) return send(res, 400, { error: "displayName must be a string or null" });
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const doc = workspaceId && await app.documents.rename(workspaceId, params[0], name);
      return doc ? send(res, 200, doc) : send(res, 404, { error: "Document not found" });
    },
    /** Body: { type: "conversation"|"research"|"assignment"|"project", targetId, role? } */
    async link({ req, res, query, params }: RouteContext) {
      const body = await readJson(req);
      if (!["conversation", "research", "assignment", "project"].includes(body.type) || typeof body.targetId !== "string") return send(res, 400, { error: "type and targetId are required" });
      const role = typeof body.role === "string" && /^[a-z_]{1,30}$/.test(body.role) ? body.role : null;
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const result = workspaceId ? await app.documents.link(workspaceId, params[0], body.type, body.targetId, role) : "not-found";
      return result === "not-found" ? send(res, 404, { error: "Document or target not found" }) : send(res, 200, result);
    },
    async unlink({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      return workspaceId && await app.documents.unlink(workspaceId, params[0], params[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Link not found" });
    },
    /** ?from&to — PDF pages, Word sections, or numbered lines for text and code. */
    async pages({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const doc = workspaceId && await app.documents.get(workspaceId, params[0]);
      if (!doc) return send(res, 404, { error: "Document not found" });
      const num = (v: string | null) => (v && /^\d{1,7}$/.test(v) ? Number(v) : undefined);
      try {
        const bytes = await app.documents.read(doc.storagePath);
        return send(res, 200, await previewDocument(bytes, doc.name, { from: num(query.get("from")), to: num(query.get("to")) }));
      } catch { return send(res, 422, { error: "This file can't be previewed." }); }
    },
    async get({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const doc = workspaceId && await app.documents.get(workspaceId, params[0]);
      return doc ? send(res, 200, toDocumentView(doc)) : send(res, 404, { error: "Document not found" });
    },
    /** The original bytes. Served with nosniff and a sandboxing CSP so an uploaded file can never run as a page. */
    async file({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const doc = workspaceId && await app.documents.get(workspaceId, params[0]);
      if (!doc) return send(res, 404, { error: "Document not found" });
      let bytes: Buffer;
      try { bytes = await app.documents.read(doc.storagePath); } catch { return send(res, 410, { error: "The stored file is missing." }); }
      res.writeHead(200, {
        "content-type": doc.mimeType, "content-length": bytes.length, "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", "cache-control": "private, max-age=3600",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`
      });
      res.end(bytes);
    },
    async remove({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      return workspaceId && await app.documents.delete(workspaceId, params[0]) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Document not found" });
    }
  };
}
