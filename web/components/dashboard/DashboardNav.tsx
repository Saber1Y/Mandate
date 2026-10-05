import Link from "next/link";
import {OwnerConnectButton} from "./OwnerConnectButton";

export function DashboardNav() {
  return (
    <div className="sticky top-0 z-50 px-4">
      <nav className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 rounded-lg border border-border bg-white/85 px-4 py-2.5 backdrop-blur-md shadow-card">
        <Link href="/" className="flex items-center px-2">
          <span className="text-[14px] font-semibold text-text-primary tracking-tight">
            Mand<span className="text-accent">ate</span>
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <Link href="/" className="hidden rounded-lg px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover sm:inline transition-colors">
            Home
          </Link>
          <OwnerConnectButton />
        </div>
      </nav>
    </div>
  );
}
