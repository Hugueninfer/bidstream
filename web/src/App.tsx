import { Link, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { EmptyState } from "./components/EmptyState";
import { FilePlusIcon } from "./components/Icons";
import { RfqDetailPage } from "./pages/RfqDetailPage";
import { RfqListPage } from "./pages/RfqListPage";
import { SupplierPage } from "./pages/SupplierPage";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<RfqListPage />} />
        <Route path="/rfqs/:rfqId" element={<RfqDetailPage />} />
        <Route path="/supplier" element={<SupplierPage />} />
        <Route
          path="*"
          element={
            <EmptyState
              bordered
              icon={<FilePlusIcon />}
              title="Page not found"
              action={
                <Link to="/" className="bs-btn-secondary">
                  Back to RFQs
                </Link>
              }
            />
          }
        />
      </Routes>
    </AppShell>
  );
}
