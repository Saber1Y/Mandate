import {Section, Eyebrow} from "./Section";
import {Card} from "@/components/ui/Card";
import {Bolt, Shield} from "@/components/ui/Icons";
import type {ReactNode} from "react";

function FenceCard({
  index,
  icon,
  title,
  kicker,
  children,
}: {
  index: string;
  icon: ReactNode;
  title: string;
  kicker: string;
  children: ReactNode;
}) {
  return (
    <Card
      tone="paper"
      pad="lg"
      className="flex flex-col gap-5 transition-shadow motion-safe:hover:shadow-elevated"
    >
      <div className="flex items-center justify-between">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/10 text-accent">
          {icon}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">{index}</span>
      </div>
      <div>
        <span className="text-[11px] font-medium uppercase tracking-wider text-accent">{kicker}</span>
        <h3 className="mt-1 text-heading-sm text-text-primary" style={{fontWeight: 600}}>
          {title}
        </h3>
      </div>
      <p className="text-body text-text-secondary">{children}</p>
    </Card>
  );
}

export function TwoFences() {
  return (
    <Section tone="dark" id="fences">
      <div data-aos="fade-up" className="max-w-[52ch]">
        <Eyebrow onDark>The architecture</Eyebrow>
        <h2 className="mt-4 text-heading leading-tight sm:text-heading-lg sm:leading-[1.1]" style={{fontWeight: 600}}>
          Two independent fences.
        </h2>
        <p className="mt-5 text-body text-white/70">
          Neither substitutes the other. One blocks off-policy requests before they&apos;re ever signed; the other
          polices the spend on-chain.
        </p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <div data-aos="fade-up" data-aos-duration="550">
          <FenceCard index="Fence 1" kicker="Server policy gate" title="It never gets signed" icon={<Bolt />}>
            Every spend request is checked against the agent&apos;s leash - active, not expired, or allowlisted, per
            service caps - before the executor key signs it. An off-policy request is rejected and logged at the
            API, so value never leaves the vault.
          </FenceCard>
        </div>
        <div data-aos="fade-up" data-aos-delay="150" data-aos-duration="550">
          <FenceCard index="Fence 2" kicker="Contract layer" title="It only moves inside policy" icon={<Shield />}>
            Even if a request passes the API, the vault re-checks the full on-chain policy - active, token allowed,
            target allowed, per-tx cap, daily cap, dedup - before moving a cent. Blocked actions emit an on-chain
            record and move nothing.
          </FenceCard>
        </div>
      </div>
    </Section>
  );
}
