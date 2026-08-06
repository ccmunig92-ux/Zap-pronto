import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return <main><h1>Zap Pronto</h1><p>Console operacional em preparação segura.</p></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
