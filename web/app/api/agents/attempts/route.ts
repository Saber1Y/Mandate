import {NextResponse} from "next/server";
import {listRejectedAttempts} from "@/lib/attempts";
import {authenticateAgent, AuthenticationError} from "@/lib/auth";
import {findCredentialByHash} from "@/lib/agents";

/**
 * Recent policy rejections, newest first.
 *
 * Authenticated with the agent bearer key and scoped to that credential's vault. A refusal is not a
 * financial outcome, but recipient, amount and agent identity are still tenant data and must not be
 * exposed to every browser that can reach the dashboard.
 */
export async function GET(request: Request) {
  try {
    const credential = await authenticateAgent(request, findCredentialByHash);
    const limitParam = new URL(request.url).searchParams.get("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 25;
    return NextResponse.json({
      attempts: listRejectedAttempts(Number.isFinite(limit) ? limit : 25, credential.vault),
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({error: e.message}, {status: e.status});
    }
    throw e;
  }
}
