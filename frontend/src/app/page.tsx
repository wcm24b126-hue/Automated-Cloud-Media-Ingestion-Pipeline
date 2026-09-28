"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Clapperboard,
  CloudUpload,
  Database,
  FileVideo2,
  Film,
  Gauge,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { AccountGate } from "@/components/account-gate";

type Asset = {
  id: string;
  filename: string;
  key: string;
  status: string;
  resolution: string | null;
  playlist: string | null;
  error: string | null;
  createdAt: string;
};

type Overview = {
  services: { localstack: boolean; postgres: boolean };
  counts: { total: number; completed: number; active: number; failed: number };
  assets: Asset[];
};

type Filter = "ALL" | "PROCESSING" | "COMPLETED" | "FAILED";
type UploadReply = {
  error?: string;
  fileId?: string;
  key?: string;
  uploadId?: string;
  etag?: string;
  chunkSize?: number;
  partURLs?: Array<{ partNumber: number; url: string }>;
};

const filters: Filter[] = ["ALL", "PROCESSING", "COMPLETED", "FAILED"];
const maximumUploadBytes = 500 * 1024 * 1024;
const uploadChunkBytes = 8 * 1024 * 1024;
const allowedExtensions = new Set([
  "mp4", "mov", "m4v", "mkv", "webm", "avi",
  "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "tif", "tiff",
  "pdf", "txt", "md", "csv", "json", "docx", "xlsx", "pptx",
  "zip", "7z", "tar", "gz", "apk", "exe", "dmg", "appimage",
]);

function statusLabel(status: string) {
  if (status === "RECEIVED" || status === "PENDING") return "Queued";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSize(bytes: number) {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

async function fetchOverview(): Promise<Overview> {
  const response = await fetch("/api/overview", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not refresh pipeline data");
  return response.json();
}

async function sendUploadRequest(body: FormData): Promise<UploadReply> {
  const response = await fetch("/api/uploads", { method: "POST", body });
  const contentType = response.headers.get("content-type") ?? "";
  const result: UploadReply | null = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : null;

  if (!response.ok) {
    const fallback = response.status === 413
      ? "The hosting service rejected an upload chunk (HTTP 413). Please retry."
      : `Upload failed with HTTP ${response.status}.`;
    throw new Error(result?.error ?? fallback);
  }
  if (!result) throw new Error("The upload server returned an unexpected response.");
  return result;
}

export default function Home() {
  return <AccountGate><Dashboard /></AccountGate>;
}

function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await fetchOverview();
        if (active) setOverview(next);
      } catch {
        if (active) setNotice("Could not reach the dashboard API. Check that Next.js is running.");
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredAssets = (overview?.assets ?? []).filter((asset) => {
    const matchesFilter =
      filter === "ALL" ||
      (filter === "PROCESSING" && ["RECEIVED", "PENDING", "PROCESSING"].includes(asset.status)) ||
      asset.status === filter;
    const matchesQuery =
      !normalizedQuery ||
      asset.filename.toLowerCase().includes(normalizedQuery) ||
      asset.key.toLowerCase().includes(normalizedQuery);
    return matchesFilter && matchesQuery;
  });

  async function refreshNow() {
    setRefreshing(true);
    try {
      setOverview(await fetchOverview());
      setNotice("");
    } catch {
      setNotice("Refresh failed. Check the API and database connection.");
    } finally {
      setRefreshing(false);
    }
  }

  function chooseFile(file?: File) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowedExtensions.has(extension)) {
      setNotice("That file type is not supported yet.");
      return;
    }
    if (file.size === 0 || file.size > maximumUploadBytes) {
      setNotice("Choose a video larger than 0 bytes and no larger than 500 MB.");
      return;
    }
    setNotice("");
    setSelectedFile(file);
  }

  async function uploadFile() {
    if (!selectedFile || uploading) return;
    setUploading(true);
    setNotice("");
    setUploadProgress(0);
    let uploadSession: { fileId: string; key: string; uploadId: string } | null = null;
    let completed = false;

    try {
      const start = new FormData();
      start.set("action", "start");
      start.set("filename", selectedFile.name);
      start.set("contentType", selectedFile.type);
      start.set("size", String(selectedFile.size));
      const started = await sendUploadRequest(start);
      if (!started.fileId || !started.key || !started.uploadId) throw new Error("Could not start the upload session.");
      uploadSession = { fileId: started.fileId, key: started.key, uploadId: started.uploadId };

      const chunkSize = started.chunkSize ?? uploadChunkBytes;
      const totalParts = Math.ceil(selectedFile.size / chunkSize);
      const parts: Array<{ PartNumber: number; ETag: string }> = [];
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const startOffset = (partNumber - 1) * chunkSize;
        const chunk = selectedFile.slice(startOffset, Math.min(startOffset + chunkSize, selectedFile.size));
        let etag: string | null | undefined;
        const signedPart = started.partURLs?.find((part) => part.partNumber === partNumber);
        if (signedPart) {
          const response = await fetch(signedPart.url, { method: "PUT", body: chunk });
          if (!response.ok) throw new Error(`Part ${partNumber} upload failed with HTTP ${response.status}.`);
          etag = response.headers.get("etag");
          if (!etag) throw new Error("R2 did not expose the ETag header. Check the bucket CORS exposeHeaders setting.");
        } else {
          const part = new FormData();
          part.set("action", "part");
          part.set("fileId", uploadSession.fileId);
          part.set("key", uploadSession.key);
          part.set("uploadId", uploadSession.uploadId);
          part.set("partNumber", String(partNumber));
          part.set("chunk", chunk, `${selectedFile.name}.part-${partNumber}`);
          const uploadedPart = await sendUploadRequest(part);
          etag = uploadedPart.etag;
        }
        if (!etag) throw new Error(`Could not upload part ${partNumber}.`);
        parts.push({ PartNumber: partNumber, ETag: etag });
        setUploadProgress(Math.round((partNumber / totalParts) * 100));
      }

      const finish = new FormData();
      finish.set("action", "complete");
      finish.set("fileId", uploadSession.fileId);
      finish.set("key", uploadSession.key);
      finish.set("uploadId", uploadSession.uploadId);
      finish.set("parts", JSON.stringify(parts));
      await sendUploadRequest(finish);
      completed = true;
      setNotice(`${selectedFile.name} sent to the ingestion queue.`);
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setOverview(await fetchOverview());
    } catch (error) {
      if (uploadSession && !completed) {
        const abort = new FormData();
        abort.set("action", "abort");
        abort.set("fileId", uploadSession.fileId);
        abort.set("key", uploadSession.key);
        abort.set("uploadId", uploadSession.uploadId);
        await sendUploadRequest(abort).catch(() => undefined);
      }
      setNotice(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  const connected = Boolean(overview?.services.localstack && overview.services.postgres);
  const count = overview?.counts;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Signal home">
          <span className="brand-mark"><Clapperboard size={19} strokeWidth={2.2} /></span>
          <span className="brand-name">signal<span>.</span></span>
        </a>

        <div className="workspace-switcher">
          <span className="workspace-avatar">AC</span>
          <span className="workspace-copy"><strong>ACME Studio</strong><small>Media workspace</small></span>
          <ChevronRight className="workspace-chevron" size={15} />
        </div>

        <p className="nav-caption">WORKSPACE</p>
        <nav className="main-nav" aria-label="Main navigation">
          <a className="nav-item active" href="#overview"><LayoutDashboard size={17} /> Overview</a>
          <a className="nav-item" href="#assets"><Film size={17} /> Media library <span className="nav-count">{count?.total ?? "-"}</span></a>
          <a className="nav-item" href="#pipeline"><Activity size={17} /> Pipeline</a>
        </nav>

        <div className="sidebar-bottom">
          <div className="storage-mini">
            <div className="storage-heading"><span>LOCAL STORAGE</span><HardDrive size={14} /></div>
            <div className="storage-value">S3 emulator <span>{overview?.services.localstack ? "Online" : "Offline"}</span></div>
            <div className="storage-track"><i /></div>
            <small>LocalStack / ap-south-1</small>
          </div>
          <a className="nav-item settings-link" href="#pipeline"><Settings2 size={17} /> Settings</a>
          <div className="user-chip">
            <div className="user-avatar">W</div>
            <div><strong>Workspace user</strong><small>Local development</small></div>
            <button className="user-menu" onClick={() => { void authClient.signOut(); }} aria-label="Sign out" title="Sign out"><LogOut size={15} /></button>
          </div>
        </div>
      </aside>

      <section className="main-panel" id="overview">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>Overview</strong></div>
          <div className="topbar-actions">
            <div className={`system-pill ${connected ? "online" : "offline"}`}>
              <span className="status-dot" />
              {connected ? "All systems operational" : "Service connection issue"}
            </div>
            <button className={`icon-button ${refreshing ? "is-spinning" : ""}`} onClick={refreshNow} aria-label="Refresh dashboard" title="Refresh dashboard">
              <RefreshCw size={17} />
            </button>
          </div>
        </header>

        <div className="content-wrap">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> MEDIA WORKSPACE</div>
              <h1>Files and media</h1>
              <p>Upload and organize files. Videos are transcoded after security checks.</p>
            </div>
            <div className="today-stamp"><Clock3 size={15} /> LIVE VIEW <span>/</span> AUTO-REFRESH 10S</div>
          </section>

          {notice && (
            <div className="notice" role="status">
              {notice.includes("sent") ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
              <span>{notice}</span>
              <button onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={16} /></button>
            </div>
          )}

          <section className="metric-grid" aria-label="Pipeline metrics">
            <article className="metric metric-total">
              <div className="metric-top"><span>ASSETS RECEIVED</span><FileVideo2 size={17} /></div>
              <div className="metric-value">{count?.total ?? "—"}</div>
              <div className="metric-foot"><span className="metric-bullet" /> Since pipeline start</div>
            </article>
            <article className="metric">
              <div className="metric-top"><span>COMPLETED</span><CheckCircle2 size={17} /></div>
              <div className="metric-value">{count?.completed ?? "—"}</div>
              <div className="metric-foot">Files ready to download</div>
            </article>
            <article className="metric">
              <div className="metric-top"><span>IN PROGRESS</span><Activity size={17} /></div>
              <div className="metric-value">{count?.active ?? "—"}</div>
              <div className="metric-foot">Uploads, scans, transcodes</div>
            </article>
            <article className="metric metric-alert">
              <div className="metric-top"><span>NEEDS ATTENTION</span><CircleAlert size={17} /></div>
              <div className="metric-value">{count?.failed ?? "—"}</div>
              <div className="metric-foot">Rejected or failed jobs</div>
            </article>
          </section>

          <section className="work-grid" id="pipeline">
            <div className="upload-panel">
              <div className="section-heading">
                <div><span className="section-kicker">01 / INTAKE</span><h2>Send footage</h2></div>
                <span className="panel-icon"><CloudUpload size={19} /></span>
              </div>
              <div
                className={`dropzone ${dragging ? "dragging" : ""} ${selectedFile ? "has-file" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
              >
                {selectedFile ? (
                  <div className="selected-file">
                    <span className="file-symbol"><FileVideo2 size={21} /></span>
                    <div className="selected-file-copy"><strong>{selectedFile.name}</strong><small>{formatSize(selectedFile.size)} / Ready to upload</small></div>
                    <button className="remove-file" onClick={() => { setSelectedFile(null); if (inputRef.current) inputRef.current.value = ""; }} aria-label="Remove selected file"><X size={17} /></button>
                  </div>
                ) : (
                  <>
                    <span className="upload-symbol"><ArrowDownToLine size={21} /></span>
                    <strong>Drop files to upload</strong>
                    <span className="drop-copy">or <button onClick={() => inputRef.current?.click()}>browse files</button></span>
                  </>
                )}
                <input ref={inputRef} className="file-input" type="file" accept="video/*,image/*,.pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.zip,.7z,.tar,.gz,.apk,.exe,.dmg,.appimage" onChange={(event) => chooseFile(event.target.files?.[0])} />
              </div>
              <div className="upload-footer">
                <span>Video, images, docs, archives, apps / max 500 MB</span>
                <button className="upload-button" disabled={!selectedFile || uploading || !overview?.services.localstack} onClick={uploadFile}>
                  {uploading ? <LoaderCircle className="spin" size={16} /> : <CloudUpload size={16} />}
                  {uploading ? `Sending ${uploadProgress}%...` : "Start ingest"}
                </button>
              </div>
              {uploading && <div className="upload-progress" role="progressbar" aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${uploadProgress}%` }} /></div>}
            </div>

            <div className="pipeline-panel">
              <div className="section-heading">
                <div><span className="section-kicker">02 / PIPELINE</span><h2>Service status</h2></div>
                <span className="panel-icon"><Gauge size={19} /></span>
              </div>
              <div className="service-list">
                <div className="service-row">
                  <span className="service-icon localstack-icon"><CloudUpload size={17} /></span>
                  <div className="service-copy"><strong>Object storage</strong><small>LocalStack / S3 + SQS</small></div>
                  <span className={`service-state ${overview?.services.localstack ? "good" : "bad"}`}><i />{overview?.services.localstack ? "Connected" : "Offline"}</span>
                </div>
                <div className="service-row">
                  <span className="service-icon database-icon"><Database size={17} /></span>
                  <div className="service-copy"><strong>Metadata store</strong><small>PostgreSQL / mediadb</small></div>
                  <span className={`service-state ${overview?.services.postgres ? "good" : "bad"}`}><i />{overview?.services.postgres ? "Connected" : "Offline"}</span>
                </div>
                <div className="pipeline-route">
                  <span>RAW VIDEO</span><i /><span>SQS EVENT</span><i /><span>HLS OUTPUT</span>
                </div>
              </div>
              <div className="pipeline-foot"><span><span className="pulse-dot" /> S3 event notifications configured</span><span>ap-south-1</span></div>
            </div>
          </section>

          <section className="assets-section" id="assets">
            <div className="assets-heading">
              <div><span className="section-kicker">03 / ACTIVITY</span><h2>Recent assets <span>{count?.total ?? 0}</span></h2></div>
              <div className="table-tools">
                <label className="search-field"><Search size={15} /><input aria-label="Search assets" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assets" /></label>
              </div>
            </div>

            <div className="filter-tabs" role="tablist" aria-label="Filter assets">
              {filters.map((item) => <button key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)} role="tab" aria-selected={filter === item}>{item === "ALL" ? "All assets" : statusLabel(item)}</button>)}
            </div>

            <div className="table-wrap">
              <table>
                <thead><tr><th>ASSET</th><th>INGESTED</th><th>STATUS</th><th>OUTPUT</th><th aria-label="Open asset" /></tr></thead>
                <tbody>
                  {filteredAssets.map((asset) => (
                    <tr key={asset.id}>
                      <td><div className="asset-name"><span className="asset-file-icon"><FileVideo2 size={17} /></span><span><strong>{asset.filename}</strong><small>{asset.key}</small></span></div></td>
                      <td className="date-cell">{formatDate(asset.createdAt)}</td>
                      <td><span className={`status-tag status-${asset.status.toLowerCase()}`}><i />{statusLabel(asset.status)}</span></td>
                      <td className="output-cell">{asset.playlist ?? (asset.error ? "Needs review" : "—")}</td>
                      <td>{asset.status === "AVAILABLE" ? <a className="row-link" href={`/api/files/${asset.id}/download`} aria-label={`Download ${asset.filename}`}><ArrowUpRight size={16} /></a> : null}</td>
                    </tr>
                  ))}
                  {filteredAssets.length === 0 && (
                    <tr><td colSpan={5}><div className="empty-state"><span className="empty-icon"><Film size={19} /></span><strong>{query || filter !== "ALL" ? "No matching assets" : "Your intake is clear"}</strong><small>{query || filter !== "ALL" ? "Try a different search or status." : "Upload a video above to start the first transcode."}</small></div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="table-bottom"><span>Showing {filteredAssets.length} of {count?.total ?? 0} assets</span><button onClick={refreshNow} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Refresh data</button></div>
          </section>

          <footer className="page-footer"><span>Signal / media ingestion</span><span>LOCAL ENVIRONMENT <i /> {connected ? "CONNECTED" : "CHECK SERVICES"}</span></footer>
        </div>
      </section>
    </main>
  );
}
