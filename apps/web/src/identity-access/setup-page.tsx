import { useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

import styles from "./setup-page.module.css";
import { Button, Field, StatusNotice } from "../ui/control";

export type SetupAvailability = "available-local" | "code-required";
export interface SetupResult { token: string; workspaceId: string; starterNoteId: string }

interface SetupPageProps {
  readonly state: SetupAvailability;
  readonly fetcher?: typeof fetch;
  readonly onComplete?: (result: SetupResult) => void;
}

function defaultCompletion(result: SetupResult) {
  window.location.assign(`/app/notes/${encodeURIComponent(result.starterNoteId)}`);
}

export function SetupPage({ state, fetcher = fetch, onComplete = defaultCompletion }: SetupPageProps) {
  const [step, setStep] = useState<"identity" | "workspace">("identity");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const workspaceNameRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (step === "workspace") workspaceNameRef.current?.focus();
  }, [step]);
  useLayoutEffect(() => {
    if (error && !pending) submitRef.current?.focus();
  }, [error, pending]);

  useGSAP(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(`.${styles.reveal}`, { y: 18 }, {
      y: 0, duration: 0.5, stagger: 0.06, ease: "power2.out", clearProps: "all",
    });
  }, { scope: rootRef, dependencies: [step] });

  const createWorkspace = async () => {
    setPending(true);
    setError("");
    try {
      const payload = { name, email, password, workspaceName,
        ...(state === "code-required" ? { setupCode } : {}) };
      const response = await fetcher("/api/instance/setup", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as Partial<SetupResult> & { message?: string };
      if (!response.ok || !body.token || !body.workspaceId || !body.starterNoteId) {
        throw new Error(body.message || "Setup could not be completed. Try again.");
      }
      const result = { token: body.token, workspaceId: body.workspaceId, starterNoteId: body.starterNoteId };
      localStorage.setItem("stash.member-session", JSON.stringify({ token: result.token }));
      onComplete(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup could not be completed. Try again.");
    } finally {
      setPending(false);
    }
  };

  return <main className={styles.page} ref={rootRef}>
    <div className={styles.layout}>
      <section className={styles.introduction} aria-labelledby="setup-title">
        <div className={`${styles.brand} ${styles.reveal}`}>
          <img className={styles.brandMark} src="/assets/stash-logo-mark-temporary.svg" alt="" />
          <strong>Stash</strong>
        </div>
        <h1 aria-label="Keep the thread." className={styles.reveal} id="setup-title">Keep the<br /><span>thread.</span></h1>
        <img className={styles.artwork} src="/assets/setup-thread.png" alt="" />
      </section>
      <section className={styles.panel} aria-labelledby="form-title">
        <div className={styles.mobileBrand}>Step {step === "identity" ? "1" : "2"} of 2</div>
        <div className={styles.progress} aria-label={`Step ${step === "identity" ? "1" : "2"} of 2`} role="progressbar" aria-valuemin={1} aria-valuemax={2} aria-valuenow={step === "identity" ? 1 : 2}>
          <span className={step === "identity" ? styles.active : styles.complete} /><span className={step === "workspace" ? styles.active : ""} />
        </div>
        {step === "identity" ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); setStep("workspace"); }}>
          <div className={styles.reveal}><h2 id="form-title">Create your Stash Workspace</h2><p>You’ll be the first owner and admin of this Instance.</p></div>
          <div className={styles.reveal}><Field label="Name"><input aria-label="Name" autoComplete="name" autoFocus maxLength={200} required value={name} onChange={(event) => setName(event.target.value)} /></Field></div>
          <div className={styles.reveal}><Field label="Email"><input aria-label="Email" autoComplete="email" maxLength={320} required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field></div>
          <Button className={`${styles.primary} ${styles.reveal}`} type="submit">Continue</Button>
        </form> : <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void createWorkspace(); }}>
          <div className={styles.reveal}><h2 id="form-title">Create your Stash Workspace</h2><p>Name your space and secure the first owner account.</p></div>
          <div className={styles.reveal}><Field label="Workspace name"><input aria-label="Workspace name" autoComplete="organization" maxLength={200} ref={workspaceNameRef} required value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></Field></div>
          <div className={styles.reveal}><Field hint="Use at least 12 characters." label="Password"><input aria-label="Password" autoComplete="new-password" minLength={12} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field></div>
          {state === "code-required" ? <div className={styles.reveal}><Field hint="Copy the short-lived code from the Instance startup output. If the setup code is missing or has expired, restart Stash to issue a new code." label="Setup code"><input aria-label="Setup code" autoCapitalize="characters" autoComplete="one-time-code" required value={setupCode} onChange={(event) => setSetupCode(event.target.value)} /></Field></div> : null}
          {error ? <StatusNotice className={styles.error} tone="error">{error}</StatusNotice> : <StatusNotice className={styles.security} tone={state === "available-local" ? "success" : "attention"}>{state === "available-local" ? "This loopback-only connection can claim the Instance directly." : "This networked Instance is protected by an operator code."}</StatusNotice>}
          <div className={styles.actions}>
            <Button className={styles.secondary} disabled={pending} type="button" variant="secondary" onClick={() => setStep("identity")}>Back</Button>
            <button className={styles.primary} disabled={pending} ref={submitRef} type="submit">{pending ? "Creating…" : "Create my Workspace"}</button>
          </div>
        </form>}
      </section>
    </div>
  </main>;
}
