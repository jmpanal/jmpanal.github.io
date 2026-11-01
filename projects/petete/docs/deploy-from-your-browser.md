# Deploy Petete from your own browser

This route does not use ChatGPT's browser session. Cloudflare's API token and the app's initial password remain encrypted as GitHub repository secrets. They are not committed to source or pasted into chat.

## 1. Create the Cloudflare deployment token

In your usual browser, open https://dash.cloudflare.com/profile/api-tokens and create a token using the Edit Cloudflare Workers template. Add the account permissions D1 Edit, Vectorize Edit, Workers AI Read and Workers AI Edit. Keep the template's Workers Scripts and Workers Routes permissions. Scope the account permissions to the account hosting jmpanal.com and the zone permissions to jmpanal.com.

Cloudflare reference: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ and https://developers.cloudflare.com/fundamentals/api/reference/permissions/.

Copy the token after creating it. Copy your Account ID from the domain Overview API section or Cloudflare dashboard search using Copy account ID. The Account ID is32 hexadecimal characters, not the Zone ID.

## 2. Add four repository secrets

Open https://github.com/jmpanal/jmpanal.github.io/settings/secrets/actions. For each entry, select New repository secret:

| Name | Value |
| --- | --- |
| CLOUDFLARE_API_TOKEN | The token you just created |
| CLOUDFLARE_ACCOUNT_ID | The account's32-character ID |
| PETETE_ADMIN_EMAIL | The email you will use to sign into Petete |
| PETETE_ADMIN_PASSWORD | Your chosen Petete password,12 to256 characters |

Use repository secrets, not repository variables. The workflow can also inherit matching secrets from its petete-production environment, but creating that environment manually is not required. If you have already configured environment secrets with the same names, they take precedence.

## 3. Run deployment

Open https://github.com/jmpanal/jmpanal.github.io/actions/workflows/petete-deploy.yml. Select Run workflow, keep main selected, then Run workflow.

The workflow validates settings, provisions or reuses D1 and Vectorize, applies migrations, initializes verified sample records and embedding chunks, deploys only the /petete routes, creates the first administrator, and queues current and historical DGT imports. It does not replace an existing administrator or reset their password. Rerunning the workflow is safe for existing documents and accounts. If the existing admin password differs from the current secret, initialization stops without resetting it.

After the workflow succeeds, open https://www.jmpanal.com/petete/ and use the email/password above. Historical import and AI indexing run in the background. CENDOJ authorization is a separate data-access dependency.

If deployment fails, open the failed step and share its error text or workflow link. Do not share the token or password. The workflow prints missing setting names and sanitized status errors, not secret values. Provider permission/plan restrictions remain visible failures; the workflow does not purchase or change a paid plan.
