import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import type { ExportJob } from "../types";

export function Exports() {
  const [exports, setExports] = useState<ExportJob[]>([]);

  useEffect(() => {
    void apiGet<ExportJob[]>("/api/exports").then(setExports);
  }, []);

  return (
    <section className="page-stack">
      <div className="section-header">
        <span className="eyebrow">Exports</span>
        <h1>导出历史</h1>
        <p>审核通过的片段会在这里生成粗剪 MP4、字幕和元数据。</p>
      </div>
      <div className="table-panel">
        {exports.length === 0 ? (
          <p className="empty">暂无导出任务。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>状态</th>
                <th>进度</th>
                <th>输出</th>
              </tr>
            </thead>
            <tbody>
              {exports.map((job) => (
                <tr key={job.id}>
                  <td>#{job.id}</td>
                  <td>{job.status}</td>
                  <td>{job.progress}%</td>
                  <td>{job.output_path || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
