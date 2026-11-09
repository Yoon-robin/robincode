import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { fitWindow } from "./fit.js";
import "./styles.css";

fitWindow();
createRoot(document.getElementById("root")).render(<App />);
