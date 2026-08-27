import { useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

import styles from "./setup-page.module.css";

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
          <svg className={styles.brandMark} viewBox="0 0 64 52" aria-hidden="true">
            <path d="M14 4h37a9 9 0 0 1 9 9v2a9 9 0 0 1-9 9H25c-4 0-6 2-6 6H4V14A10 10 0 0 1 14 4Z" />
            <path d="M50 48H13a9 9 0 0 1-9-9v-2a9 9 0 0 1 9-9h26c4 0 6-2 6-6h15v16a10 10 0 0 1-10 10Z" />
          </svg>
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
          <div className={styles.reveal}><p className={styles.stepName}>Set up your Workspace</p><h2 id="form-title">Make Stash yours</h2><p>You’ll be the first owner and admin of this Instance.</p></div>
          <label className={styles.reveal}>Name<input aria-label="Name" autoComplete="name" autoFocus maxLength={200} required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className={styles.reveal}>Email<input aria-label="Email" autoComplete="email" maxLength={320} required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <button className={`${styles.primary} ${styles.reveal}`} type="submit">Continue</button>
        </form> : <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void createWorkspace(); }}>
          <div className={styles.reveal}><p className={styles.stepName}>Set up your Workspace</p><h2 id="form-title">Create your Stash Workspace</h2><p>Name your space and secure the first owner account.</p></div>
          <label className={styles.reveal}>Workspace name<input aria-label="Workspace name" autoComplete="organization" maxLength={200} ref={workspaceNameRef} required value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
          <label className={styles.reveal}>Password<input aria-label="Password" autoComplete="new-password" minLength={12} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /><small>Use at least 12 characters.</small></label>
          {state === "code-required" ? <label className={styles.reveal}>Setup code<input aria-label="Setup code" autoCapitalize="characters" autoComplete="one-time-code" required value={setupCode} onChange={(event) => setSetupCode(event.target.value)} /><small>Copy the short-lived code from the Instance startup output.</small></label> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.security} role="status">{state === "available-local" ? "This loopback-only connection can claim the Instance directly." : "This networked Instance is protected by an operator code."}</p>}
          <div className={styles.actions}>
            <button className={styles.secondary} disabled={pending} type="button" onClick={() => setStep("identity")}>Back</button>
            <button className={styles.primary} disabled={pending} ref={submitRef} type="submit">{pending ? "Creating…" : "Create my Workspace"}</button>
          </div>
        </form>}
      </section>
    </div>
  </main>;
}
