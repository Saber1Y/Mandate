import {Section, Eyebrow} from "./Section";

const steps = [
  {
    n: "01",
    title: "Create your vault",
    body: "Pick a leash (max per transaction, daily cap) and sign once. The factory deploys a vault owned by your wallet - one vault per wallet, self-configured with the leash you chose.",
  },
  {
    n: "02",
    title: "Fund it with tUSDT",
    body: "Grab testnet gas and tUSDT from the faucet, then deposit into the vault. Your agent can only ever spend what is sitting in the vault - it never holds a balance itself.",
  },
  {
    n: "03",
    title: "Hand your agent a key",
    body: "Register the agent and get a one-time API key for any AI agent (opencode, ChatGPT, Claude). It introspects its leash and pays within it - and you can tighten the leash or allow services any time, signed in your wallet.",
  },
];

export function HowItWorks() {
  return (
    <Section tone="paper" id="how">
      <div data-aos="fade-up">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="mt-4 max-w-[24ch] text-heading leading-tight text-text-primary sm:text-heading-lg sm:leading-[1.1]" style={{fontWeight: 600}}>
          Fund the vault. Fence the agent.
        </h2>
        <p className="mt-5 max-w-[56ch] text-body text-text-secondary">
          A self-serve control plane - anyone gets their own vault in a few minutes. Two independent fences
          (the app policy gate and the on-chain vault) enforce the leash on every payment.
        </p>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {steps.map((s, i) => (
          <div
            key={s.n}
            data-aos="fade-up"
            data-aos-delay={i * 120}
            className="flex flex-col gap-4 rounded-lg border border-border p-6 transition-shadow motion-safe:hover:shadow-elevated sm:p-8"
          >
            <span className="text-heading text-accent" style={{fontWeight: 600}}>
              {s.n}
            </span>
            <h3 className="text-heading-sm text-text-primary" style={{fontWeight: 600}}>
              {s.title}
            </h3>
            <p className="text-body-sm text-text-secondary">{s.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
