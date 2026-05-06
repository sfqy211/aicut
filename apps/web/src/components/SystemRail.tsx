import { Eye, Moon, Radio, Rows3, Settings2, Sun, WandSparkles } from "lucide-react";
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
  const { collapsed, toggle } = useSidebar();

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <button className="sidebar-toggle" onClick={toggle} title={collapsed ? "展开侧栏" : "收起侧栏"}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="20" height="20">
          <path fill="currentColor" d="M896 192H128v128h768zm0 256H384v128h512zm0 256H128v128h768zM320 384 128 512l192 128z" />
        </svg>
      </button>

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
