import Link from "next/link";
import {Bolt, Shield, Hand, ArrowUpRight} from "@/components/ui/Icons";

const STEPS = [
  {
    icon: Bolt,
    step: "1",
    title: "Create your vault",
    body: "One signature deploys a vault owned by your wallet and sets your agent's leash.",
  },
  {
    icon: Hand,
    step: "2",
    title: "Fund it with tUSDT",
    body: "Grab testnet funds and deposit tUSDT. Your agent can only spend what the vault holds.",
  },
  {
    icon: Shield,
    step: "3",
    title: "Register your agent",
    body: "Bind this wallet as the agent and mint a one-time API key for your AI agent.",
  },
];

/** First-step guidance shown to a connected user who has not created an agent yet. */
export function AgentOnboarding() {
  return (
    <div className="kpi-card p-6 sm:p-8" data-aos="fade-up">
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-light text-accent">
          <Bolt width={22} height={22} />
        </div>
        <div className="text-[18px] font-semibold text-text-primary tracking-tight">Create your agent to get started</div>
        <div className="mt-2 max-w-[440px] text-[13px] text-text-muted">
          Your wallet gets its own on-chain vault, deposits its own tUSDT, and the agent spends under a leash you set. It takes three
          steps - about a minute.
        </div>
        <Link
          href="/dashboard/agents"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[13px] font-medium text-white hover:bg-accent-hover transition"
        >
          Create my agent
          <ArrowUpRight width={16} height={16} />
        </Link>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {STEPS.map(({icon: Icon, step, title, body}) => (
          <div key={step} className="rounded-lg border border-border bg-white p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-light text-accent">
                <Icon width={18} height={18} />
              </div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Step {step}</span>
            </div>
            <div className="text-[13px] font-semibold text-text-primary">{title}</div>
            <div className="mt-1 text-[12px] leading-relaxed text-text-muted">{body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
