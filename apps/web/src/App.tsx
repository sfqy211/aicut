import { useState } from "react";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SidebarProvider, useSidebar } from "./contexts/SidebarContext";
import { SystemRail } from "./components/SystemRail";
import { Dashboard } from "./pages/Dashboard";
import { Exports } from "./pages/Exports";
import { Review } from "./pages/Review";
import { Sessions } from "./pages/Sessions";
import { Sources } from "./pages/Sources";
import { ChevronLeft, ChevronRight } from "lucide-react";

function AppContent() {
  const [page, setPage] = useState("dashboard");
  const { collapsed, toggle } = useSidebar();

  return (
    <main className="app-shell">
      <SystemRail activePage={page} onNavigate={setPage} />
      <section className="main">
        <header className="topbar">
          <button className="collapse-btn" onClick={toggle}>
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
          <h1 className="topbar-title">
            AICut 运营控制台
            <span className="mono">REC-ANALYZE-REVIEW</span>
          </h1>
          <div className="topbar-actions">
            <div className="live-indicator">
              <span className="status-dot"></span>
              <span className="mono">LIVE DATA</span>
            </div>
          </div>
        </header>
        <div className="content">
          {page === "dashboard" && <Dashboard />}
          {page === "sources" && <Sources />}
          {page === "sessions" && <Sessions />}
          {page === "review" && <Review />}
          {page === "exports" && <Exports />}
        </div>
        <footer className="footer">
          <div className="footer-status">
            <span className="footer-status-item">
              <span className="status-dot"></span>
              <span className="mono">SYSTEM ONLINE</span>
            </span>
            <span className="footer-status-item">
              <span className="status-dot"></span>
              <span className="mono">DB_CONN_OK</span>
            </span>
            <span className="footer-status-item">
              <span className="status-dot"></span>
              <span className="mono">SSE_STREAM_ACTIVE</span>
            </span>
          </div>
          <div className="mono">AICut Console v1.0.0</div>
        </footer>
      </section>
    </main>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <SidebarProvider>
        <AppContent />
      </SidebarProvider>
    </ThemeProvider>
  );
}
