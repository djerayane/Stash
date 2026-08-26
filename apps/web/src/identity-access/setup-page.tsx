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
    gsap.fromTo(`.${styles.assurance}`, { y: 22, scale: 0.985 }, {
      y: 0, scale: 1, duration: 0.45, stagger: 0.07, ease: "power2.out", clearProps: "all",
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
    <nav className={styles.navigation} aria-label="First-run setup">
      <span className={styles.brandMark} aria-hidden="true">S</span>
      <strong>Stash</strong>
      <span>Step {step === "identity" ? "1" : "2"} of 2</span>
    </nav>
    <div className={styles.layout}>
      <section className={styles.introduction} aria-labelledby="setup-title">
        <p className={`${styles.eyebrow} ${styles.reveal}`}>A personal place to think</p>
        <h1 aria-label="Make Stash yours." className={styles.reveal} id="setup-title">Make Stash <span className={styles.inlineImage} aria-hidden="true" /> yours.</h1>
        <p className={`${styles.lede} ${styles.reveal}`}>Create one personal Workspace. You can add people, Organizations, and integrations when they become useful.</p>
        <div className={styles.assuranceGrid}>
          <article className={styles.assurance}><strong>Start with Notes</strong><span>A small editable branch shows nesting and links.</span></article>
          <article className={styles.assurance}><strong>Plan real work</strong><span>Two real sample Tasks give the guide room to grow.</span></article>
          <article className={styles.assurance}><strong>Keep it portable</strong><span>Your Workspace remains yours to export.</span></article>
          <article className={styles.assurance}><strong>Remove the guide</strong><span>Move, edit, or trash the starter branch anytime.</span></article>
        </div>
      </section>
      <section className={styles.panel} aria-labelledby="form-title">
        <div className={styles.progress} aria-hidden="true"><span className={step === "identity" ? styles.active : styles.complete} /><span className={step === "workspace" ? styles.active : ""} /></div>
        {step === "identity" ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); setStep("workspace"); }}>
          <div className={styles.reveal}><p className={styles.stepName}>About you</p><h2 id="form-title">Who is this Workspace for?</h2><p>These details identify you inside Stash.</p></div>
          <label className={styles.reveal}>Name<input aria-label="Name" autoComplete="name" autoFocus maxLength={200} required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className={styles.reveal}>Email<input aria-label="Email" autoComplete="email" maxLength={320} required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <button className={`${styles.primary} ${styles.reveal}`} type="submit">Continue</button>
        </form> : <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void createWorkspace(); }}>
          <div className={styles.reveal}><p className={styles.stepName}>Your space</p><h2 id="form-title">Name the place where ideas grow.</h2><p>Use a familiar name. You can change it later.</p></div>
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
