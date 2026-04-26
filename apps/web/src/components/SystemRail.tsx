import { Activity, Eye, Moon, Radio, Rows3, Settings2, Sun, WandSparkles } from "lucide-react";
import { useTheme } from "../contexts/ThemeContext";
import { useSidebar } from "../contexts/SidebarContext";

type Props = {
  activePage: string;
  onNavigate: (page: string) => void;
};

const items = [
  { id: "sources", label: "直播源", icon: Radio },
  { id: "sessions", label: "会话管理", icon: Rows3 },
  { id: "live-preview", label: "实时预览", icon: Eye },
  { id: "review", label: "切片审核", icon: WandSparkles },
  { id: "settings", label: "系统设置", icon: Settings2 },
];

export function SystemRail({ activePage, onNavigate }: Props) {
  const { theme, toggleTheme } = useTheme();
  const { collapsed } = useSidebar();

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <div className="brand-icon">
          <Activity size={14} />
        </div>
        {!collapsed && <span className="brand-text">AICUT</span>}
      </div>

      <nav className="nav">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`nav-item ${activePage === item.id ? "active" : ""}`}
              onClick={() => onNavigate(item.id)}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={18} />
              {!collapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button
          className={`theme-toggle-btn ${collapsed ? "icon-only" : ""}`}
          onClick={toggleTheme}
          title={collapsed ? (theme === "light" ? "切换深色模式" : "切换浅色模式") : undefined}
        >
          {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
          {!collapsed && <span>{theme === "light" ? "深色模式" : "浅色模式"}</span>}
        </button>
      </div>
    </aside>
  );
}
