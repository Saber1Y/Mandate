import {Logo} from "@/components/ui/Logo";
import {explorerAddress} from "@/lib/chain";
import {TUSDT_ADDRESS, BOT_EXPLORER_URL, mandateFactory} from "@/lib/bot";
import {ArrowUpRight} from "@/components/ui/Icons";

/**
 * Footer links are built from live config rather than hardcoded placeholders.
 *
 * If Mandate addresses are not configured the deployment links are dropped rather than rendered
 * pointing at the zero address, which is what the previous CONTRACTS map would have done.
 */
function buildLinks(): {label: string; href: string}[] {
  const links: {label: string; href: string}[] = [{label: "Explorer", href: BOT_EXPLORER_URL}];
  try {
    links.unshift({label: "Vault factory", href: explorerAddress(mandateFactory())});
  } catch {
    // Not configured in this build; omit instead of linking a meaningless address.
  }
  links.push({label: "tUSDT", href: explorerAddress(TUSDT_ADDRESS)});
  return links;
}

export function SiteFooter() {
  const links = buildLinks();

  return (
    <footer className="border-t border-border bg-white px-6">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 py-12 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Logo height={30} />

          <p className="mt-3 max-w-[40ch] text-[12px] text-text-muted">
            On-chain spending controls for autonomous AI agents. The vault is the ledger; the
            organization wallet holds the authority.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[13px] text-text-secondary transition hover:text-accent"
            >
              {l.label}
              <ArrowUpRight width={13} height={13} className="text-text-muted" />
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}