import { Activity, Database, Radio, WandSparkles } from "lucide-react";

type Props = {
  activePage: string;
  onNavigate: (page: string) => void;
};

const items = [
  { id: "dashboard", label: "总览", icon: Activity },
  { id: "sources", label: "直播源", icon: Radio },
  { id: "review", label: "审核", icon: WandSparkles },
  { id: "exports", label: "导出", icon: Database },
];

export function SystemRail({ activePage, onNavigate }: Props) {
  return (
    <nav className="system-rail">
      <div className="brand-mark">AC</div>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className={activePage === item.id ? "active" : ""}
            onClick={() => onNavigate(item.id)}
          >
            <Icon size={18} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
