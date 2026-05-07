import { useCallback, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SidebarProvider, useSidebar } from "./contexts/SidebarContext";
import { SystemRail } from "./components/SystemRail";
import { LivePreview } from "./pages/LivePreview";
import { Review } from "./pages/Review";
import { Settings } from "./pages/Settings";
import { Sessions } from "./pages/Sessions";
import { Sources } from "./pages/Sources";
import { ArrowLeft } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

function AppContent() {
  const [page, setPage] = useState("sources");
  const [livePreviewSessionId, setLivePreviewSessionId] = useState<number | null>(null);
  const { collapsed, toggle } = useSidebar();
  const pageHistory = useRef<string[]>(["sources"]);

  const navigateTo = useCallback((newPage: string) => {
    setPage((prev) => {
      pageHistory.current.push(prev);
      return newPage;
    });
  }, []);

  const goBack = useCallback(() => {
    const prev = pageHistory.current.pop();
    if (prev) {
      setPage(prev);
    }
  }, []);

  const enterLivePreview = useCallback((sessionId: number) => {
    setLivePreviewSessionId(sessionId);
    navigateTo("live-preview");
  }, [navigateTo]);

  const canGoBack = pageHistory.current.length > 1;

  const pageTitles: Record<string, string> = {
    "sources": "直播源",
    "sessions": "会话管理",
    "live-preview": "实时预览",
    "review": "切片审核",
    "settings": "系统设置",
  };

  return (
    <main className="app-shell">
      <SystemRail activePage={page} onNavigate={navigateTo} />
      <section className="main">
        <header className="topbar">
          <button className="collapse-btn" onClick={goBack} disabled={!canGoBack} title="返回">
            <ArrowLeft size={18} />
          </button>
          <h1 className="topbar-title">
            {pageTitles[page] ?? "AICut"}
          </h1>
        </header>
        <div className={`content ${page === "live-preview" ? "content-live-preview" : ""}`}>
          {page === "sources" && <Sources />}
          {page === "sessions" && <Sessions onEnterLivePreview={enterLivePreview} />}
          {page === "live-preview" && <LivePreview sessionId={livePreviewSessionId} />}
          {page === "review" && <Review />}
          {page === "settings" && <Settings />}
        </div>
      </section>
    </main>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SidebarProvider>
          <AppContent />
        </SidebarProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
