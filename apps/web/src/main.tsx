import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api/client";
import { createAppRouter } from "./router";
import "./styles.css";
import { startTheme } from "./theme";

startTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    // Client errors (4xx) won't fix themselves; only retry network/server trouble.
    queries: { retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500) },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={300}>
        <RouterProvider router={createAppRouter()} />
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
