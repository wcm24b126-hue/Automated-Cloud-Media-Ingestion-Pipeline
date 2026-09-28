"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

type Workspace = { id: string; name: string; slug: string };

export function AccountGate({ children }: { children: ReactNode }) {
  const { data: authState, isPending } = authClient.useSession();
  const [workspaceData, setWorkspaceData] = useState<{
    userId: string;
    organizations: Workspace[];
    activeOrganizationId: string | null;
  } | null>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const userId = authState?.user?.id;
  useEffect(() => {
    if (!userId) return;
    let active = true;
    fetch("/api/workspaces", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not load workspaces.");
        if (active) {
          const nextWorkspaces = result.organizations as Workspace[];
          setWorkspaceData({
            userId,
            organizations: nextWorkspaces,
            activeOrganizationId: result.activeOrganizationId,
          });
          if (!result.activeOrganizationId && nextWorkspaces.length === 1) {
            return fetch("/api/workspaces", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ organizationId: nextWorkspaces[0].id }),
            }).then(() => setWorkspaceData({
              userId,
              organizations: nextWorkspaces,
              activeOrganizationId: nextWorkspaces[0].id,
            }));
          }
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setWorkspaceData({ userId, organizations: [], activeOrganizationId: null });
          setMessage(error instanceof Error ? error.message : "Could not load workspaces.");
        }
      })
      ;
    return () => { active = false; };
  }, [userId]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (authMode === "signup") {
        const result = await authClient.signUp.email({ name, email, password });
        if (result.error) throw new Error(result.error.message ?? "Sign-up failed.");
        setMessage("Account created. If email verification is enabled, check your inbox before signing in.");
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message ?? "Sign-in failed.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: workspaceName }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not create workspace.");
      setWorkspaceData((current) => current && ({
        ...current,
        organizations: [...current.organizations, result.organization],
        activeOrganizationId: result.organization.id,
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create workspace.");
    } finally {
      setBusy(false);
    }
  }

  async function selectWorkspace(organizationId: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not select workspace.");
      setWorkspaceData((current) => current && ({ ...current, activeOrganizationId: organizationId }));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not select workspace.");
    } finally {
      setBusy(false);
    }
  }

  const currentWorkspaceData = userId && workspaceData?.userId === userId ? workspaceData : null;

  if (isPending || (userId && !currentWorkspaceData)) {
    return <main className="auth-screen"><div className="auth-card"><span className="auth-mark">S</span><p>Checking your workspace...</p></div></main>;
  }

  if (!authState?.user) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <Link className="brand auth-brand" href="/"><span className="brand-mark">S</span><span className="brand-name">signal<span>.</span></span></Link>
          <div className="eyebrow"><span className="eyebrow-line" /> PRIVATE MEDIA WORKSPACE</div>
          <h1>{authMode === "signin" ? "Welcome back" : "Create your account"}</h1>
          <p className="auth-intro">Sign in to your media workspace to upload and manage files.</p>
          <form className="auth-form" onSubmit={submitAuth}>
            {authMode === "signup" && <label>Name<input autoComplete="name" required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label>}
            <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} required minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button className="upload-button" disabled={busy}>{busy ? "Please wait..." : authMode === "signin" ? "Sign in" : "Create account"}</button>
          </form>
          <p className="auth-switch">
            {authMode === "signin" ? "New here?" : "Already registered?"}
            <button onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setMessage(""); }}>
              {authMode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>
          {message && <p className="auth-message" role="status">{message}</p>}
        </section>
      </main>
    );
  }

  if (!currentWorkspaceData?.activeOrganizationId) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <span className="auth-mark">S</span>
          <div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE ACCESS</div>
          <h1>Choose a workspace</h1>
          <p className="auth-intro">Files and activity are isolated by workspace membership.</p>
          {currentWorkspaceData?.organizations.map((workspace) => (
            <button className="workspace-choice" key={workspace.id} onClick={() => selectWorkspace(workspace.id)} disabled={busy}>
              <span className="workspace-avatar">{workspace.name.slice(0, 2).toUpperCase()}</span><span><strong>{workspace.name}</strong><small>{workspace.slug}</small></span>
            </button>
          ))}
          <form className="auth-form" onSubmit={createWorkspace}>
            <label>Create workspace<input required minLength={2} maxLength={80} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Studio or team name" /></label>
            <button className="upload-button" disabled={busy}>{busy ? "Creating..." : "Create workspace"}</button>
          </form>
          {message && <p className="auth-message" role="status">{message}</p>}
        </section>
      </main>
    );
  }

  return <>{children}</>;
}