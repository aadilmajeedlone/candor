# Google sign-in (Application Default Credentials) for Gemini

> **Cost warning.** The default endpoint here, Vertex AI, is **billed by Google and needs a Google Cloud project with billing enabled** — Candor never switches billing on for you. If you do not want to pay, do not use this route: use a local model, a friend's GPU, or a Gemini API key that Google AI Studio shows as free of charge. See [FREE-OPTIONS.md](FREE-OPTIONS.md) for what was checked.

Use this when you cannot or do not want to create a Gemini **API key** — for example when your Google Cloud organisation enforces a policy that says *“API keys are disallowed … Please use Application Default Credentials (ADC) instead.”*

Candor signs in the same way Google's own tools do. You log in once with the Google Cloud CLI (`gcloud`); Google's official `google-auth-library` finds that login, turns it into short-lived access tokens, and Candor attaches them to its requests. **No API key is needed, stored or logged.**

> **Status of this feature.** It is covered by automated tests that run Google's real auth library against a local stand-in for Google's token endpoint, and the whole request path against a local server that speaks the Gemini / Vertex AI wire format. It has **not** been run against a real Google account (none was available where it was built), so treat your first *Check sign-in* on your own machine as the acceptance test — the messages below tell you what to do if something is off.

## Which endpoint should I use?

| Endpoint | Sign-in needed | Choose it when |
|---|---|---|
| **Vertex AI** *(default, recommended)* | plain `gcloud auth application-default login` | You have a Google Cloud project with billing. This is the path Google documents for ADC. |
| **Gemini API** with an OAuth token | `gcloud auth application-default login` **with your own OAuth client** (`--client-id-file`) and extra scopes — see Google's [OAuth quickstart](https://ai.google.dev/gemini-api/docs/oauth) | You specifically need the Gemini Developer API (for example its free tier) and are able to create an OAuth client in your project. |

Both use the same Gemini models and the same streaming code in Candor.

## Set-up on Windows (Vertex AI)

Open **PowerShell** and run these one at a time. Replace `YOUR_PROJECT_ID` with the ID (not the name) of your Google Cloud project — `gcloud projects list` shows your projects.

```powershell
# 1. Install the Google Cloud CLI (once), then close and reopen PowerShell
winget install -e --id Google.CloudSDK

# 2. Let the gcloud tool itself run the commands below (opens your browser)
gcloud auth login

# 3. The sign-in that apps such as Candor use (opens your browser again)
gcloud auth application-default login

# 4. Choose the project, and bill it for requests made with your sign-in
gcloud config set project YOUR_PROJECT_ID
gcloud auth application-default set-quota-project YOUR_PROJECT_ID

# 5. Turn on Vertex AI for the project
gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT_ID
```

Two things only a project administrator can change, if you do not own the project:

* **Permission** — your account needs the *Vertex AI User* role (`roles/aiplatform.user`) on the project:
  `gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="user:you@example.com" --role="roles/aiplatform.user"`
* **Billing** — the project must be linked to a billing account (Vertex AI usage is billed; new Google Cloud accounts may get trial credit).

Then in Candor:

1. **Settings → AI Providers → Add provider → Start from → “Google (Gemini) — sign in with gcloud, no API key”**.
   (In the first-run guide, pick the same entry under *Connect an AI provider*.)
2. Enter your **Project ID** (leave the region as `global` unless you know you need another) and press **Save**.
3. Candor immediately runs **Check sign-in**. When it says *Signed in with your Google account · billing project …*, press **Test & fetch models**.
4. Under **Quick setup**, press **Save & test**. That is the **Live Model Test**: it sends a real one-word request through the same path a live question uses and shows the time to first word.

If a model has no quota on your account, Candor tries the other suitable Gemini models and tells you which one it chose.

**Self-repair (Gemini API keys only).** Older versions of Candor sometimes picked models that cannot work for you — a computer-use preview, a deep-research agent, a model with no free quota — and that choice stays saved after an upgrade. When Google's answer proves the model itself is the problem (the free-tier “no quota at all” reply, “model not found”, or a non-chat model refused), Candor lists your models, tries up to five suitable ones with tiny test requests, switches to the first that answers, saves it under *Settings → Models* and shows a notice. It never touches a Vertex/sign-in provider, never changes a model for an ordinary rate limit or a bad key, and if no model has quota it says so, lists what it tried and stops asking for ten minutes.

### What “Check sign-in” tells you

| Message | Meaning and fix |
|---|---|
| **Google sign-in (ADC) was not found on this PC** | Nothing has run `gcloud auth application-default login` yet (or `GOOGLE_APPLICATION_CREDENTIALS` points at a missing file). Run it, then press *Check sign-in*. |
| **Your Google sign-in has expired or was revoked** | Run `gcloud auth application-default login` again. Some organisations force a fresh sign-in every few hours (Google Cloud *session control*); this is normal for them. |
| **Google would not issue a token for these credentials** | The credential is disabled, or your organisation blocks the gcloud sign-in. Ask your Workspace/Cloud administrator. |
| **Could not reach Google to get a sign-in token** | No connection to `oauth2.googleapis.com`. Behind a proxy? Set `HTTPS_PROXY` and restart Candor. |
| **No Google Cloud project is set** | Type the Project ID in the provider settings, or run the two `set project` commands above. |
| *…API is turned off for project X* | Run the `gcloud services enable …` command shown in the message, wait a minute, retry. |
| *…may not use project X for quota* | Your account lacks *Service Usage Consumer* on that project, or use another project with `gcloud auth application-default set-quota-project`. |
| *…needs the “Vertex AI User” role* | Ask a project admin for `roles/aiplatform.user`. |
| *Billing is not enabled for project X* | Link a billing account in the Cloud console. |
| *Google's free tier gives “model” no quota* | That model has no free-tier quota on your project — a limit, not a payment problem (it also tells you the project is on the free tier). Pick another model in **Settings → Models** (a Flash-Lite one usually has the most), let Quick setup find one, or use a local model. Do not turn on billing to get around it. |

Everything Candor shows here is written so it never contains a token, key or secret.

## Other ways to provide credentials

Google's library looks for credentials in this order; Candor changes nothing about it.

1. **`GOOGLE_APPLICATION_CREDENTIALS`** — a path to a service-account key file or a workload-identity-federation config. (Many organisations forbid service-account keys; prefer the next option.)
2. **The file written by `gcloud auth application-default login`** — `%APPDATA%\gcloud\application_default_credentials.json`.
3. **An attached service account** when Candor runs on a Google Cloud VM.

To act as a service account without a key file: `gcloud auth application-default login --impersonate-service-account=SA_EMAIL`.

The project can also come from the environment: `GOOGLE_CLOUD_PROJECT`. See [`.env.example`](../.env.example).

## Gemini API endpoint with ADC (advanced)

Google's documentation for the Gemini Developer API says the ADC sign-in must use **your own OAuth client** and two scopes:

```powershell
gcloud auth application-default login `
  --client-id-file=client_secret.json `
  --scopes='https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever'
```

Create the OAuth client (type *Desktop app*) in your project's Cloud console first, download it as `client_secret.json`, and turn on the *Generative Language API*. In Candor choose **Endpoint → Gemini API (own OAuth client)**. If you skip the client file you will get *“insufficient authentication scopes”* — the message says so.

## Using an API key as well (optional fallback)

A provider set to Google sign-in may *also* hold an API key (or use `GEMINI_API_KEY` from the environment). Candor uses the key **only when there is no Google sign-in on the PC at all**, and only against the Gemini API. An expired or rejected sign-in is reported as a problem to fix; it is never silently replaced by a different credential.

## What Candor does with your credentials

* It never reads, copies or stores the credential file. Google's library reads it; Candor only receives the resulting short-lived access token.
* Tokens live in memory only, are never written to the database or the logs (log redaction knows the shape of Google access tokens, refresh tokens, authorization keys, JWTs and private keys), and are never sent to the interface.
* A token is only ever attached to a request to a Google API address (`…googleapis.com`; loopback is allowed for development and tests). A mistyped or hostile base URL cannot receive one — Candor refuses to save it and refuses to send.
* The file `%APPDATA%\gcloud\application_default_credentials.json` holds a long-lived refresh token. Protect your Windows account, and remove it when you are done with `gcloud auth application-default revoke`.

## Troubleshooting checklist

1. `gcloud --version` works in a **new** PowerShell window (otherwise the installer's PATH change has not taken effect).
2. `gcloud auth application-default login` finished without an error, and the file above exists.
3. The Project ID is the *ID* (lowercase, with hyphens), not the display name.
4. The project has billing, the Vertex AI API is on, and you hold *Vertex AI User*.
5. Press **Check sign-in** again after any change — it re-reads your login each time.
   If the browser page during `gcloud auth login` says the app is *blocked*, your Google Workspace administrator has to allow **Google Cloud SDK** (Admin console → Security → Access and data control → API controls).
6. Logs are in `%APPDATA%\Candor\logs\candor.log`. They never contain credentials.
