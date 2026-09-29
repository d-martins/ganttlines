import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./api/query-client";
import { createAppRouter } from "./router";
import "./styles.css";
import { startTheme } from "./theme";

startTheme();

const queryClient = createQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={300}>
        <RouterProvider router={createAppRouter()} />
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
