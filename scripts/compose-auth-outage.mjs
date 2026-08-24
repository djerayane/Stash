const baseUrl = process.env.STASH_URL ?? "http://127.0.0.1:3000";
const action = process.argv[2];
const email = "compose-auth-smoke@stash.test";
const password = ["compose", "authentication", "smoke", "password"].join("-");

async function json(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { response, body };
}

async function signIn(candidatePassword = password) {
  return json("/api/auth/sessions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: candidatePassword }) });
}

async function requireClientSession(token) {
  const { response, body } = await json("/api/client-session", { headers: { authorization: `Bearer ${token}` } });
  if (response.status !== 200 || body.member?.email !== email || !body.workspace?.id) throw new Error(`client-session check failed (${response.status})`);
}

if (action === "register") {
  const { response, body } = await json("/api/auth/registration", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Compose Auth Smoke", email, password }) });
  if (response.status !== 201 || !body.token) throw new Error(`registration check failed (${response.status})`);
  await requireClientSession(body.token);
  const invalid = await signIn("incorrect password value");
  if (invalid.response.status !== 401 || invalid.body.error !== "invalid_credentials") throw new Error(`invalid-credential check failed (${invalid.response.status})`);
} else if (action === "unavailable") {
  const unavailable = await signIn();
  if (unavailable.response.status !== 503 || unavailable.body.error !== "authentication_unavailable") throw new Error(`database-outage check failed (${unavailable.response.status})`);
} else if (action === "recovered") {
  let signedIn;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    signedIn = await signIn();
    if (signedIn.response.status === 201) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (signedIn?.response.status !== 201 || !signedIn.body.token) throw new Error(`database-recovery check failed (${signedIn?.response.status})`);
  await requireClientSession(signedIn.body.token);
} else {
  throw new Error("usage: node scripts/compose-auth-outage.mjs <register|unavailable|recovered>");
}
