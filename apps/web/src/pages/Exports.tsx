import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import type { ExportJob } from "../types";

export function Exports() {
  const [exports, setExports] = useState<ExportJob[]>([]);

  useEffect(() => {
    void apiGet<ExportJob[]>("/api/exports").then(setExports);
  }, []);

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">导出历史</span>
        <span className="tag">{exports.length} EXPORTS</span>
      </div>
      {exports.length === 0 ? (
        <div className="panel-body text-muted">暂无导出任务</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>状态</th>
              <th>进度</th>
              <th>输出路径</th>
            </tr>
          </thead>
          <tbody>
            {exports.map((job) => (
              <tr key={job.id}>
                <td className="mono">#{job.id}</td>
                <td className={job.status === "completed" ? "text-success" : job.status === "failed" ? "text-danger" : "text-muted"}>
                  {job.status}
                </td>
                <td>
                  <div className="mono">{job.progress}%</div>
                  <div className="bar-bg" style={{ width: 80 }}>
                    <div className="bar-fill accent" style={{ width: `${job.progress}%` }} />
                  </div>
                </td>
                <td className="text-muted">{job.output_path || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
