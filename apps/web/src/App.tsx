import { useCallback, useState } from "react";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SidebarProvider, useSidebar } from "./contexts/SidebarContext";
import { SystemRail } from "./components/SystemRail";
import { Exports } from "./pages/Exports";
import { LivePreview } from "./pages/LivePreview";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";
import { Sessions } from "./pages/Sessions";
import { Sources } from "./pages/Sources";
import { ChevronLeft, ChevronRight } from "lucide-react";

function AppContent() {
  const [page, setPage] = useState("sources");
  const [livePreviewSessionId, setLivePreviewSessionId] = useState<number | null>(null);
  const { collapsed, toggle } = useSidebar();

  const enterLivePreview = useCallback((sessionId: number) => {
    setLivePreviewSessionId(sessionId);
    setPage("live-preview");
  }, []);

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
          </h1>
        </header>
        <div className={`content ${page === "live-preview" ? "content-live-preview" : ""}`}>
          {page === "sources" && <Sources />}
          {page === "sessions" && <Sessions onEnterLivePreview={enterLivePreview} />}
          {page === "live-preview" && <LivePreview sessionId={livePreviewSessionId} />}
          {page === "review" && <Review />}
          {page === "exports" && <Exports />}
          {page === "settings" && <Settings />}
        </div>
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
