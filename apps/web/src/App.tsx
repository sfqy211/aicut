import { useState } from "react";
import { SystemRail } from "./components/SystemRail";
import { Dashboard } from "./pages/Dashboard";
import { Exports } from "./pages/Exports";
import { Review } from "./pages/Review";
import { Sources } from "./pages/Sources";

export function App() {
  const [page, setPage] = useState("dashboard");

  return (
    <main className="app-shell">
      <SystemRail activePage={page} onNavigate={setPage} />
      <section className="workspace">
        {page === "dashboard" && <Dashboard />}
        {page === "sources" && <Sources />}
        {page === "review" && <Review />}
        {page === "exports" && <Exports />}
      </section>
    </main>
  );
}
