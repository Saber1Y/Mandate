/**
 * The agent handoff.
 *
 * Issuing an API key is not the same as giving an agent the ability to use it. A bare `mdt_…` string
 * tells a model nothing about which endpoints exist, what the leash is, or what to do first, so the
 * first thing most agents do is guess an endpoint or invent a number and get rejected by policy for
 * a reason neither it nor its operator understands.
 *
 * This builds a self-contained prompt containing everything the agent needs to be useful on the first
 * turn: the leash in human units, the recipients it may pay, the base URL, the exact request shapes,
 * and a concrete first task. The numbers are quoted from the vault at the moment the prompt is
 * generated, so the prompt cannot describe a policy that has since changed.
 *
 * It is text, not code: the model still has to decide to follow it.
 */

export interface HandoffLeash {
  /** Connected owner / default agent address. */
  agent: string;
  /** Live policy caps, already in base units. */
  maxPerTx: bigint;
  dailyCap: bigint;
  remainingDailyCap: bigint;
  /** 0 means the agent settles with no human signature. */
  approvalThreshold: number;
  policyExpiry: bigint;
  tokenAddress: string;
  tokenSymbol: string;
  /** Recipients the agent may pay. Empty means it currently may pay nobody. */
  recipients: {address: string; label: string; maxPerTx: bigint}[];
  vault: string;
}

/** Render a base-unit tUSDT amount as a plain decimal, without locale separators. */
function plain(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * `apiKey` is passed in rather than read from anywhere else: it exists only in the response to the
 * issue call and is never retrievable again, so the prompt has to be built at the moment it is known.
 */
export function agentHandoffPrompt(
  leash: HandoffLeash,
  context: {baseUrl: string; apiKey: string},
): string {
  const {baseUrl, apiKey} = context;
  const dec = 6;
  const maxTx = plain(leash.maxPerTx, dec);
  const cap = plain(leash.dailyCap, dec);
  const remaining = plain(leash.remainingDailyCap, dec);

  const approvalLine =
    leash.approvalThreshold === 0
      ? "Requests are approved automatically on arrival, so anything inside the leash settles without asking anyone. Ask before exceeding it rather than trying."
      : `${leash.approvalThreshold} owner signature${leash.approvalThreshold === 1 ? "" : "s"} required before a request settles.`;

  const expiryLine =
    leash.policyExpiry > 0n
      ? `This policy expires at unix ${leash.policyExpiry}.`
      : "This policy never expires.";

  const recipientLines =
    leash.recipients.length > 0
      ? leash.recipients
          .map((r) => {
            const capNote = r.maxPerTx > 0n ? `, at most ${plain(r.maxPerTx, dec)} each` : "";
            return `- ${r.address}${r.label ? ` (${r.label})` : ""}${capNote}`
          })
          .join("\n")
      : "- none - every payment attempt will be rejected until an owner allowlists a recipient";

  return `You are the spending agent for a Mandate treasury. Everything you can do is decided on-chain
before it happens; this prompt is your operating brief, not a request to be obeyed blindly.

API base URL: ${baseUrl}
Agent address: ${leash.agent}
Vault: ${leash.vault}
API key: ${apiKey}

YOUR LEASH (enforced by the vault, not by you)
- Max per transaction: ${maxTx} ${leash.tokenSymbol}
- Daily total: ${cap} ${leash.tokenSymbol}
- Remaining today: ${remaining} ${leash.tokenSymbol}
- ${approvalLine}
- ${expiryLine}
- You may move only ${leash.tokenSymbol} (${leash.tokenAddress}).

RECIPIENTS YOU MAY PAY
${recipientLines}

HOW TO CALL IT
Send the key as an HTTP header on every call:
  Authorization: Bearer <API_KEY>

1. Read your leash and current budget:
   GET ${baseUrl}/api/agents/me
   Returns your policy, remaining daily cap, vault balance and request history as the chain sees them.

2. Request a payment:
   POST ${baseUrl}/api/requests
   Content-Type: application/json
   {"amount":"<base units, integer string>","recipient":"<allowlisted address>","idempotencyKey":"<32-byte hex>"}

   \`amount\` is in base units and must be a whole number as a string - 1.5 is rejected, and so is a
   decimal value that looks human-readable. 1.25 ${leash.tokenSymbol} is "1250000".

   \`idempotencyKey\` must be 32 bytes of hex (0x plus 64 characters). Generate a fresh random one per
   real payment and reuse it verbatim when retrying the same payment, so a network retry can never
   become two payments. Reusing one key with different parameters is rejected on purpose.

START HERE
First call GET ${baseUrl}/api/agents/me and read back the policy you were given. Then request one
small payment inside the leash - a small fraction of ${maxTx}, to an allowlisted recipient - and report
what the chain decided: the requestId and status, or the rejection reason.

RULES THAT ARE NOT OPTIONAL
- Never construct an amount larger than the per-transaction limit. The vault rejects it and you cannot
  retry your way past it.
- Only pay recipients listed above. An unlisted address is rejected regardless of amount.
- If a request comes back rejected, report the reason and stop. Do not retry with a larger or split
  amount to get around it.
- Do not ask for a larger leash. If the limit is too low for the task, say so and let the owner decide.`;
}