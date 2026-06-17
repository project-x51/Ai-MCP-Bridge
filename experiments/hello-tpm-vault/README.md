# Experiment: encrypt-to-user vault via TPM / Windows Hello

Feasibility probe for the persistence-vault idea (architecture §12 follow-on): encrypt durable data
**to the user** (a TPM-backed key gated by Windows Hello), so the **session secret is only an auth
bearer** — never needed to read the data, and freely remappable on loss without the secret ever
travelling back over the MCP channel. The hard question was whether Windows can give us a key that
**decrypts** (for envelope-unwrap), gated by the human — `KeyCredentialManager` (the easy Hello API) is
**sign-only**, so we need CNG/TPM (`Microsoft Platform Crypto Provider`).

## The three claims

| # | Claim | Needs a human? | Status on ROBIN-Z790 |
|---|---|---|---|
| 1 | A TPM-backed CNG key can **encrypt + decrypt** (RSA-OAEP), not just sign | no | **PROVEN** (2026-06-17) |
| 2 | **Multi-machine envelope**: one data key wrapped to several TPM public keys; each machine unwraps its own copy; no machine can open another's | no | **PROVEN** (2026-06-17) |
| 3 | The decrypt can be gated by a real **Windows Hello FACE** prompt | yes | **PROVEN** (2026-06-17) — `FaceProbe.exe` |

Test 2 simulates "two machines" as two TPM keys on one box; the crypto is identical to real machines
exchanging **public** key blobs (which are safe to store in the realm). To test it for real across
ROBIN ↔ VOLT, run the probe on each, export each machine's public blob, and wrap to both.

## Run

- **Any time, no prompt:** `run-noninteractive.cmd` → Tests 0–2.
- **At the keyboard (morning):** `run-interactive.cmd` → Test 3. A Windows security prompt should
  appear; approve it, and **note what kind it is** — face/fingerprint = biometric Hello, or a PIN /
  consent box. That distinction tells us whether decrypt can be *biometric*-gated or only PIN/consent
  gated (either is fine for the design; we just want to know which).

Keys (`aimb-exp-*`) are created in the TPM and **deleted after each run**. Build needs only the in-box
.NET Framework `csc` (same as the tray); `Probe.exe`/`*.pdb` are gitignored.

## Result (2026-06-17) — ALL THREE PROVEN on ROBIN-Z790

- `run-noninteractive.cmd` → **6/6** (TPM decrypts, multi-machine envelope, per-machine isolation).
- `FaceProbe.exe` → a real **Windows Hello FACE** prompt gated the TPM decrypt. End to end:
  `Hello Available → face Verified → TPM decrypt`.

So the whole "encrypt-to-user, secret-as-auth-bearer, recover-by-remap" design is feasible.

### API findings (matter for the build)
- The earlier "create a password" box was **`CngUIPolicy`** — the legacy per-key password, NOT Hello. Don't use it.
- The real face prompt is **`UserConsentVerifier`** (`Windows.Security.Credentials.UI`). It's a *presence/consent
  check* (returns Verified), separate from the key — we gate the TPM decrypt on `Verified`. So the binding is
  **procedural** (the trusted tray won't decrypt without a successful Hello), not a hard crypto seal of the key
  to biometrics (that path — Hello-for-Business / `KeyCredentialManager` — is **sign-only**, can't decrypt).
- `UserConsentVerifier.RequestVerificationAsync()` (parameterless) **throws from a windowless process**. Use the
  HWND interop **`IUserConsentVerifierInterop.RequestVerificationForWindowAsync(hwnd, ...)`**. The **tray** has a
  window handle → this is its natural home.
- **Runtime matters:** .NET Framework supports this classic WinRT interop (`WindowsRuntimeMarshal` + IInspectable
  + HString); **CsWinRT / .NET 10 does not** ("IInspectable marshalling not supported"). The tray is .NET
  Framework (in-box `csc`) → it Just Works there. (`facetest/` is the failed .NET 10 attempt, kept as a record.)
- Compile needs the OS winmds: `C:\Windows\System32\WinMetadata\Windows.{Foundation,Security}.winmd` + the
  `System.Runtime` facade + `System.Runtime.WindowsRuntime.dll`. See the csc line in git history / below.

## What this means for §12

If Test 3 also passes: the persistence body key becomes a **per-user data key wrapped to each of the
user's TPM keys**; the bridge/tray Hello-unlocks it once and caches it in RAM; the session secret drops
to a pure (remappable, never-returned) delivery-auth token. That gives strong per-user at-rest privacy
*and* clean loss-recovery — the best of both branches we'd been weighing.
