import {NextResponse} from "next/server";
import {listRejectedAttempts} from "@/lib/attempts";

/**
 * Recent policy rejections, newest first.
 *
 * Not authenticated and not vault-scoped. Every row describes an attempt that was *refused*, so
 * there is nothing here about money that moved, and the endpoint discloses no balance, policy or
 * request status. Filtering to a single vault would imply per-vault privacy the underlying contract
 * does not provide anyway: every vault is public on-chain and the factory exposes the full list.
 *
 * If this ever returns anything derived from a successful spend it must be authenticated first.
 */
export function GET(request: Request) {
  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 25;
  return NextResponse.json({attempts: listRejectedAttempts(Number.isFinite(limit) ? limit : 25)});
}