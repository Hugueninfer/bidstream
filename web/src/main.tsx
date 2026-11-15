import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api/client";
import { App } from "./App";
import { LiveEventsProvider } from "./live/LiveEvents";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Don't retry business errors (4xx); retry network/5xx twice.
      retry: (count, error) => (error instanceof ApiError ? error.retryable && count < 2 : count < 2),
    },
  },
});

async function bootstrap() {
  // Dev-only mock backend. `import.meta.env.DEV` is statically false in production builds,
  // so this branch and the mock chunk are dropped from the bundle.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === "1") {
    const { installMocks } = await import("./mock/install");
    installMocks();
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <LiveEventsProvider>
            <App />
          </LiveEventsProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
