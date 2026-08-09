import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.js";
import { initializeAuth, retryAuthInitialization, shouldMountAfterAuthInitialization } from "./auth.js";

const authInitialization = await initializeAuth().catch(() => ({ status: "error" as const }));
if (shouldMountAfterAuthInitialization(authInitialization)) {
  createRoot(document.getElementById("root")!).render(<StrictMode><App
    initialAuthInitializationFailed={authInitialization.status === "error"}
    retryAuthInitialization={retryAuthInitialization}/></StrictMode>);
}
