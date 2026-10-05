"use client";

import {useEffect, useState} from "react";
import {Eyebrow} from "./Section";
import {Card} from "@/components/ui/Card";
import {TxChip, Chip} from "@/components/ui/Chip";
import {Skeleton} from "@/components/ui/Row";
import {truncateAddress, truncateHash, formatTusdt, timeAgo} from "@/lib/format";
import {explorerTx} from "@/lib/chain";
import {useSpendHistory} from "@/lib/useChainRead";
import type {SpendEvent} from "@/lib/reads";

/**
 * Live activity, read from MandateVault events.
 *
 * This replaced a proof endpoint that returned recorded rows and a snapshot fixture, so both
 * columns below are now genuine chain reads. The distinction the old UI drew between "live" and
 * "recorded" no longer exists because there is only one source.
 */

const KIND_LABEL: Record<SpendEvent["kind"], string> = {
  requested: "SpendRequested",
  approved: "RequestApproved",
  executed: "RequestExecuted",
  rejected: "RequestRejected",
  expired: "RequestExpired",
  cancelled: "RequestCancelled",
  settled: "ReceiptIssued",
};

function EventColumn({
  title,
  subtitle,
  events,
  loading,
  match,
}: {
  title: string;
  subtitle: string;
  events: SpendEvent[];
  loading: boolean;
  match: (e: SpendEvent) => boolean;
}) {
  const chosen = events.filter(match).slice(0, 1);

  return (
    <Card tone="paper" pad="lg" className="flex h-full flex-col gap-6">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-text-primary">{title}</span>
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <Chip tone="accent">live read</Chip>
        )}
      </div>

      <div>
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
          amount
        </span>
        {chosen.length > 0 ? (
          <div
            className="mt-1 text-heading-lg leading-none text-text-primary"
            style={{fontWeight: 600}}
          >
            {formatTusdt(chosen[0].amount)}{" "}
            <span className="text-heading-sm text-text-muted">tUSDT</span>
          </div>
        ) : (
          <Skeleton className="mt-2 h-12 w-40" />
        )}
      </div>

      <div className="space-y-3 border-t border-border pt-5 text-[13px]">
        <Line label="Event">
          {chosen.length > 0 ? (
            <span className="text-text-primary">{KIND_LABEL[chosen[0].kind]}</span>
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </Line>
        <Line label="Recipient">
          {chosen.length > 0 ? (
            <span className="font-mono text-text-primary">
              {truncateAddress(chosen[0].target)}
            </span>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
        </Line>
        <Line label="Result">
          <span className="text-text-primary">
            {chosen.length > 0 ? "settled from vault-held balance" : "nothing has happened yet"}
          </span>
        </Line>
        <Line label="Transaction">
          {chosen.length > 0 ? (
            <TxChip href={explorerTx(chosen[0].txHash)} label={truncateHash(chosen[0].txHash)} />
          ) : (
            <Skeleton className="h-6 w-32" />
          )}
        </Line>
      </div>
    </Card>
  );
}

function Line({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted">{label}</span>
      {children}
    </div>
  );
}

export function LiveProof() {
  const {data, loading} = useSpendHistory({limit: 50});

  const events = data ?? [];
  const latestExecuted = events.find((e) => e.kind === "executed");
  const latestBlocked =
    events.find((e) => e.kind === "rejected" || e.kind === "expired" || e.kind === "cancelled") ??
    undefined;

  return (
    <section id="proof" className="bg-surface-muted px-6">
      <div className="mx-auto max-w-[1200px] py-16 sm:py-20 lg:py-24">
        <div data-aos="fade-up" className="max-w-[56ch]">
          <Eyebrow>Live proof - on-chain</Eyebrow>
          <h2
            className="mt-4 text-heading leading-tight text-text-primary sm:text-heading-lg sm:leading-[1.1]"
            style={{fontWeight: 600}}
          >
            Same vault. One variable.
          </h2>
          <p className="mt-5 text-body text-text-secondary">
            Two real reads from the Mandate vault on BOT Chain - an approved spend that settled,
            and a request the policy stopped. Event history straight from the contract, not a
            simulation and not a recorded row.
          </p>
        </div>

        <div className="mt-12 grid items-stretch gap-6 lg:grid-cols-[1fr_auto_1fr]">
          <div data-aos="fade-up" data-aos-duration="550">
            <EventColumn
              title="Settled"
              subtitle="RequestExecuted"
              events={latestExecuted ? [latestExecuted] : []}
              loading={loading}
              match={(e) => e.kind === "executed"}
            />
          </div>
          <div className="flex items-center justify-center">
            <span className="rounded-full border border-border bg-white px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
              vs
            </span>
          </div>
          <div data-aos="fade-up" data-aos-delay="150" data-aos-duration="550">
            <EventColumn
              title="Stopped"
              subtitle="rejected, expired, or cancelled"
              events={latestBlocked ? [latestBlocked] : []}
              loading={loading}
              match={(e) => e.kind === "rejected" || e.kind === "expired" || e.kind === "cancelled"}
            />
          </div>
        </div>

        {events.length > 0 && !loading ? (
          <p className="mt-6 text-center text-[12px] text-text-muted">
            {events.length} spend event{events.length === 1 ? "" : "s"} read from the vault
            {latestExecuted?.timestamp ? ` · newest settlement ${timeAgo(Number(latestExecuted.timestamp))}` : ""}
          </p>
        ) : null}
      </div>
    </section>
  );
}

