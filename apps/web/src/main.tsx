import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.js";
import { initializeAuth } from "./auth.js";

await initializeAuth();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
