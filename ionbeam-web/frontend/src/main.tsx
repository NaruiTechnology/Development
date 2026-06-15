import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";

import { store } from "./store";
import { applyLocaleToDocument } from "./i18n";
import "./styles/theme.css";
import "./styles/mobile.css";

// Apply <html lang> and document.title before the first render so the
// page is correctly tagged at first paint (matters for screen readers,
// browser dictionary lookups, and anything that snapshots the DOM
// before React mounts — e.g. some browser translation toolbars).
//
// We deliberately read the store directly here rather than going
// through a top-level useEffect, because useEffect fires after first
// paint and that's exactly when we'd be applying the wrong locale to
// the document.
applyLocaleToDocument(store.getState().locale.locale);

const root = ReactDOM.createRoot(document.getElementById("root")!);

void bootstrap();

async function bootstrap() {
  const mobilityOnly = import.meta.env.VITE_MOBILITY_ONLY === "1";
  const path = window.location.pathname;
  const mobilityRoute = path.startsWith("/mobility");
  if (mobilityOnly && !path.startsWith("/mobility")) {
    window.history.replaceState(null, "", "/mobility");
  }

  if (mobilityOnly || mobilityRoute) {
    const { MobilityApp } = await import("./mobile/MobilityApp");
    root.render(
      <React.StrictMode>
        <Provider store={store}>
          <MobilityApp />
        </Provider>
      </React.StrictMode>
    );
    return;
  }

  const { App } = await import("./App");
  root.render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>
  );
}
