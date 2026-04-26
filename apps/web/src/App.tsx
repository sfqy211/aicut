import { useState } from "react";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SidebarProvider, useSidebar } from "./contexts/SidebarContext";
import { SystemRail } from "./components/SystemRail";
import { Exports } from "./pages/Exports";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";
import { Sessions } from "./pages/Sessions";
import { Sources } from "./pages/Sources";
import { ChevronLeft, ChevronRight } from "lucide-react";

function AppContent() {
  const [page, setPage] = useState("sources");
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
          </h1>
        </header>
        <div className="content">
          {page === "sources" && <Sources />}
          {page === "sessions" && <Sessions />}
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
