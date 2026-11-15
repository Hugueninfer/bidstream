import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { TENANT_ID } from "../api/client";
import type { ServiceHealth } from "../api/types";
import { readStorage, writeStorage } from "../lib/storage";
import { useTheme } from "../lib/theme";
import { useServiceHealth } from "../live/useServiceHealth";
import { healthDotClass, SERVICES } from "../lib/health";
import { ActivityDrawer } from "./ActivityDrawer";
import { Logo, MoonIcon, SunIcon } from "./Icons";
import { RoleSwitcher } from "./RoleSwitcher";
import { Dot } from "./ui";

const DRAWER_KEY = "bs-activity-open";
const DRAWER_ID = "system-activity";

function healthSummary(services: Map<ServiceHealth["name"], ServiceHealth>) {
  if (services.size === 0) return "service health unknown";
  const bad = SERVICES.filter((n) => services.get(n)?.status !== "healthy");
  return bad.length === 0 ? "all services healthy" : `${bad.join(", ")} not healthy`;
}

/** Header + main + optional activity drawer column; the drawer stacks below content under 900 px. */
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const supplier = pathname.startsWith("/supplier");
  const { theme, toggle } = useTheme();
  const services = useServiceHealth();
  const [drawerOpen, setDrawerOpen] = useState(() => readStorage(DRAWER_KEY) !== "0");

  const setOpen = (open: boolean) => {
    setDrawerOpen(open);
    writeStorage(DRAWER_KEY, open ? "1" : "0");
  };

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 shell:px-5">
          <div className="flex items-center gap-3 sm:gap-4">
            <Link to="/" className="flex items-center gap-2 rounded-md text-title-2" aria-label="BidStream home">
              <Logo />
              <span>BidStream</span>
            </Link>
            <span className="rounded-full border border-border-strong px-2.5 py-0.5 font-mono text-mono-xs text-text-2">
              {TENANT_ID}
            </span>
            <Link
              to={supplier ? "/supplier" : "/"}
              className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-body font-medium text-text"
            >
              {supplier ? "Open RFQs" : "RFQs"}
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <RoleSwitcher />
            <button
              type="button"
              onClick={toggle}
              className="flex h-9 w-9 items-center justify-center rounded-lg border bg-surface-2 text-text-2 hover:text-text"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              type="button"
              onClick={() => setOpen(!drawerOpen)}
              aria-expanded={drawerOpen}
              aria-controls={DRAWER_ID}
              className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-body font-medium ${
                drawerOpen ? "bg-surface-2 text-text" : "bg-surface text-text-2 hover:text-text"
              }`}
              title={healthSummary(services)}
            >
              <span className="flex gap-0.5" aria-hidden>
                {SERVICES.map((n) => (
                  <Dot key={n} className={`h-1.5 w-1.5 ${healthDotClass(services.get(n))}`} />
                ))}
              </span>
              Activity
              <span className="sr-only">, {healthSummary(services)}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col shell:flex-row">
        <main id="main" className="min-w-0 flex-1 px-4 pb-10 pt-6 shell:px-8 shell:pt-7">
          {children}
        </main>
        {drawerOpen && (
          <div className="border-t shell:sticky shell:top-[57px] shell:h-[calc(100vh-57px)] shell:w-[354px] shell:shrink-0 shell:border-l shell:border-t-0 max-shell:h-[560px]">
            <ActivityDrawer id={DRAWER_ID} onCollapse={() => setOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
