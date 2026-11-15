import { Link, useLocation } from "react-router-dom";

/** Buyer / Supplier segmented links. */
export function RoleSwitcher() {
  const { pathname } = useLocation();
  const supplier = pathname.startsWith("/supplier");
  const item = (active: boolean) =>
    `rounded-md px-4 py-1.5 text-body font-medium transition-colors ${
      active ? "bg-surface text-text shadow-sm" : "text-text-2 hover:text-text"
    }`;
  return (
    <nav aria-label="Role" className="inline-flex rounded-lg border bg-surface-2 p-0.5">
      <Link to="/" className={item(!supplier)} aria-current={!supplier ? "page" : undefined}>
        Buyer
      </Link>
      <Link to="/supplier" className={item(supplier)} aria-current={supplier ? "page" : undefined}>
        Supplier
      </Link>
    </nav>
  );
}
