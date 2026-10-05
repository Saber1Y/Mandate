"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useActiveAddress } from "@/lib/usePrivyWallet";
import { RoleProvider, useRole } from "@/lib/useRole";
import { truncateAddress } from "@/lib/format";
import { OwnerConnectButton } from "@/components/dashboard/OwnerConnectButton";
import { LoginGate } from "@/components/dashboard/LoginGate";
import { PageLoader } from "@/components/ui/PageLoader";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: "grid" },
  { href: "/dashboard/requests", label: "Requests", icon: "scroll" },
  { href: "/dashboard/agents", label: "Agents", icon: "bot" },
  { href: "/dashboard/settings", label: "Settings", icon: "settings" },
] as const;

const USER_NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: "grid" },
  { href: "/dashboard/requests", label: "Requests", icon: "scroll" },
  { href: "/dashboard/settings", label: "Settings", icon: "settings" },
] as const;

const SECONDARY_ITEMS = [] as const;

/** Pages a non-owner may see. Agent registration is owner-only, so it is not listed. */
const USER_ALLOWED = ["/dashboard", "/dashboard/requests", "/dashboard/settings"];

function NavIcon({ icon }: { icon: string }) {
  const cls = "w-4 h-4 shrink-0";
  switch (icon) {
    case "grid":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case "arrow-up-right":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 17 17 7M8 7h9v9" />
        </svg>
      );
    case "shield":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
        </svg>
      );
    case "bot":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 8V4H8" />
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
        </svg>
      );
    case "list-check":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m3 17 2 2 4-4" />
          <path d="m3 7 2 2 4-4" />
          <path d="M13 6h8M13 12h8M13 18h8" />
        </svg>
      );
    case "credit-card":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="1" y="4" width="22" height="16" rx="2" />
          <path d="M1 10h22" />
        </svg>
      );
    case "scroll":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
          <path d="M19 17V5a2 2 0 0 0-2-2H4" />
        </svg>
      );
    case "settings":
      return (
        <svg
          className={cls}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    default:
      return null;
  }
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RoleProvider>
      <DashboardShell>{children}</DashboardShell>
    </RoleProvider>
  );
}

function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, authenticated } = usePrivy();
  const { address, isConnected } = useActiveAddress();
  const { isOwner, loading: roleLoading } = useRole();

  const isUser = authenticated && !roleLoading && !isOwner;

  // Visitors only ever see their own pages. Operator pages redirect.
  useEffect(() => {
    if (!isUser) return;
    const allowed = USER_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + "/"));
    if (!allowed) router.replace("/dashboard");
  }, [isUser, pathname, router]);

  if (ready && !authenticated) {
    return <LoginGate />;
  }

  const navItems = isOwner ? NAV_ITEMS : USER_NAV_ITEMS;
  const subtitle = isOwner ? "Treasury control plane" : "Your agent";

  return (
    <div className="flex min-h-screen bg-surface-muted">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-[var(--sidebar-width)] flex-col bg-surface-sidebar">
        {/* Logo */}
        <div className="flex h-16 items-center gap-2.5 px-5">
          <div>
            <span className="text-md font-semibold text-white tracking-tight">
              Mandate
            </span>
            <span className="block text-[10px] text-white/40 leading-none mt-0.5">
              {subtitle}
            </span>
          </div>
        </div>

        {/* Primary nav */}
        <nav className="flex-1 overflow-y-auto sidebar-scrollbar px-3">
          <div className="space-y-0.5">
            {navItems.map((item) => {
              const active =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition motion-safe:active:scale-[0.98] ${
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-white/50 hover:bg-white/5 hover:text-white/80"
                  }`}
                >
                  <NavIcon icon={item.icon} />
                  {item.label}
                </Link>
              );
            })}
          </div>

        </nav>

        {/* Wallet & status */}
        <div className="border-t border-white/8 p-4">
          <OwnerConnectButton />
          {isConnected && address && (
            <div className="mt-3 text-[11px] text-white/30 break-all">
              {truncateAddress(address)}
            </div>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="ml-[var(--sidebar-width)] flex-1">
        {roleLoading ? (
          <PageLoader label="Resolving your role..." fill />
        ) : (
          children
        )}
      </main>
    </div>
  );
}
