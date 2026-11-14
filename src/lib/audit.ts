import type { DbOrTx } from "./db.ts";
import type { Prisma } from "../generated/prisma/client.ts";

export interface AuditEntry {
  actorUserId?: string | null;
  /** Human label for non-user actors, e.g. "server:main" or "system". */
  actorLabel?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  requestId?: string | null;
  details?: Prisma.InputJsonValue;
}

/**
 * Records an administrative action. Call it with the same transaction client as the
 * change itself so the audit row and the change commit (or roll back) together.
 */
export async function writeAudit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.adminAuditLog.create({
    data: {
      actorUserId: e.actorUserId ?? null,
      actorLabel: e.actorLabel ?? null,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      ip: e.ip ?? null,
      requestId: e.requestId ?? null,
      details: e.details,
    },
  });
}
