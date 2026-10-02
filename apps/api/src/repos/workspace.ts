import type { Db } from "../../../../packages/db/src/client.ts";

export interface LocalIdentity { userId: string; workspaces: Map<string, string> }

/**
 * Single-user local mode: one local user owns the default workspace. Real accounts will replace this
 * bootstrap; every record already carries the user/workspace ids that multi-user access needs.
 */
export async function bootstrapLocalIdentity(db: Db): Promise<LocalIdentity> {
  const user = (await db.user.findFirst({ where: { email: null }, orderBy: { createdAt: "asc" } })) ?? (await db.user.create({ data: { name: "Local user" } }));
  const workspace = await db.workspace.upsert({ where: { slug: "default" }, update: {}, create: { slug: "default", name: "My workspace" } });
  await db.membership.upsert({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } }, update: {}, create: { userId: user.id, workspaceId: workspace.id, role: "owner" } });
  return { userId: user.id, workspaces: new Map([[workspace.slug, workspace.id]]) };
}

/** Resolves a client-facing workspace slug to its id, creating it in local mode on first use. */
export async function resolveWorkspace(db: Db, identity: LocalIdentity, slug: string): Promise<string> {
  const known = identity.workspaces.get(slug);
  if (known) return known;
  const workspace = await db.workspace.upsert({ where: { slug }, update: {}, create: { slug, name: slug } });
  await db.membership.upsert({ where: { userId_workspaceId: { userId: identity.userId, workspaceId: workspace.id } }, update: {}, create: { userId: identity.userId, workspaceId: workspace.id, role: "owner" } });
  identity.workspaces.set(slug, workspace.id);
  return workspace.id;
}
