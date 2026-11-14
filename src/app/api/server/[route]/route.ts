import { handleServerApi } from "../../../../api/server-api.ts";
import { getPrisma } from "../../../../lib/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleServerApi(getPrisma(), req, { secret: process.env.TOKENSTORE_SERVER_SECRET ?? "" });
}
export const GET = POST; // the handler itself answers 405 for anything but POST
