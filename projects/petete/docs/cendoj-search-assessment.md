# CENDOJ on-demand search assessment

Checked on 2026-11-01. Scope: a user-initiated search returning ruling identifiers and summaries inside Petete, without building a complete CENDOJ archive.

## Decision

**The public website technically contains the search controls and a result-summary rendering path needed for this feature. A compliant commercial federated integration is not established by that technical accessibility.** The live official terms restrict public-database consultation to personal use and separately restrict commercial use and bulk downloading. They direct database creation or commercial reuse through CGPJ/CENDOJ's reuse process. They do not publish an exception for a commercial application that makes only one request at a time, does not cache, or retrieves metadata and summaries instead of a complete archive.

Accordingly, the app cannot truthfully mark live CENDOJ result numbers and summaries as delivered until a reuse authorization or a licensed provider covering that use is available and its interface is verified. The authorization is an external source requirement, not a requirement to obtain the user's permission before routine coding. No outreach, registration or purchase was performed in this assessment.

## Current primary evidence

### Actual live official website

A normal unauthenticated GET to this exact public search entry point returned HTTP 200 through Python's standard HTTP client:

`https://www.poderjudicial.es/search/indexAN.jsp`

The returned HTML, whose script/style version marker was `202610271444`, contains the actual `#modalAvisoLegal` notice. Its personal-use sentence states:

> El usuario de la base de datos podrá consultar los documentos siempre que lo haga para su uso particular.

The following paragraph independently prohibits commercial database use and mass downloads, and requires following CGPJ/CENDOJ conditions for database creation or commercial reuse. The notice does not distinguish server-side from client-side requests, persisted from transient responses, or complete decisions from enriched results. Treating a paid or prospective paid app's federated result service as commercial reuse is an inference from this restriction. It is not a definitive ruling on every possible private-use client.

The browser/search research transport returned HTTP 403 for the same URL. The ordinary HTTP client's successful public page retrieval was not obtained by CAPTCHA solving, proxy rotation, identity spoofing, or a security bypass. No search query was submitted after the restriction was identified, and no attempt was made to work around the blocked transport.

### Official corroboration

- Ministry of Justice, Centro de Estudios Jurídicos, CENDOJ access conditions: https://www.cej-mjusticia.es/es/biblioteca/legislacion_online . This reproduces the personal-use, commercial-use and bulk-extraction restrictions. Its page reports a 2023 modification date, so the actual live CENDOJ HTML above is the stronger evidence for the currently published terms.
- Spain's official open-data initiative: https://datos.gob.es/eu/noticias/open-data-en-el-ambito-judicial-pasado-presente-y-futuro . This 2019 explanatory article distinguishes free personal consultation from commercial reuse requiring prior CENDOJ authorization. It is contextual corroboration, not a newly issued 2026 authorization policy.
- Actual official reuse portal: https://www2.poderjudicial.es/ . It currently displays a registered-user login and the contact `consultas-reutilizacion@cgpj.es`. The visible reset-password route is https://www2.poderjudicial.es/solicitarClave.reut . The existence of a login does not show that the user has an account, that registration grants the required rights, or that there is a public search API.

Do not rely on the old Regulation 3/2010's federation definition or fee table as currently operative law. The official open-data article above reports that the regulation was annulled by the Supreme Court in 2011. The commercial-use conclusion here follows the current website notice, not that annulled regulation.

## Observed technical interface

These details were read directly from the live official HTML and its ordinary public JavaScript files. They are observations of the website implementation, **not a documented public API contract or a successful end-to-end query test**.

| Component | Observed official path or behavior |
| --- | --- |
| Public entry | `GET /search/indexAN.jsp` |
| Form | `#frmBusquedajurisprudencia`, `action="search.action"` |
| Search submission | `POST /search/search.action`, form-encoded, expected response type HTML |
| Submit code | `/search/js/common-scripts/form-components.js?guid=202610271444`, `submitForm()` and `showResults()` |
| Result-summary code | `/search/js/functions.js?guid=202610271444`, `loadSummaries()` |
| Summary DOM expected by code | `.searchresult .content .summary`; optional summaries are truncated for display and can be expanded |
| Session behavior | Search helper handles HTTP 401 as expired session; no session or CAPTCHA handling was exercised by this assessment |
| Embedding | The returned HTML declares `frame-ancestors 'self'`; embedding the full official website in an application iframe is not an established supported solution |

Observed form parameters:

| Field | Example or purpose |
| --- | --- |
| `action` | `query` |
| `databasematch` | `AN` in this public form |
| `TEXT` | Free-text terms |
| `ROJ` | Official ROJ reference |
| `ECLI` | European case-law identifier |
| `NUMERORESOLUCION` | Decision number |
| `NUMERORECURSO` | Proceeding/appeal number |
| `FECHARESOLUCIONDESDE` | Beginning of decision-date filter |
| `FECHARESOLUCIONHASTA` | End of decision-date filter |
| `JURISDICCION` | Jurisdiction filter |
| `TIPOORGANOPUB` | Court-type filter |
| `TIPORESOLUCION` | Decision-type filter |
| `sort` | Default `IN_FECHARESOLUCION:decreasing` |
| `recordsPerPage` | Default `10` |
| `start` | Default `1` |

The summary-rendering code shows that the official site expects summaries in results. It does not prove every result has a substantive summary, that these summaries are licensed separately, or that a request through a Cloudflare Worker will succeed. Some summaries may be query snippets rather than a full case analysis. No supported public JSON search endpoint, permission-free federation program, API key process or request quota was verified.

## What can ship now

1. Keep a clear link that sends the user to the official search in a separate tab for their own consultation. Do not imply this is an in-app result integration.
2. Support searching and summarizing CENDOJ records already imported under a verified authorization. Preserve source identifiers, court, issue date, source URL and complete text; label AI summaries distinctly.
3. Show an explicit unavailable-source state for live federation rather than empty results, invented case numbers, or a claim that no relevant decisions exist.

This is a delivery gap against the requested in-app **CENDOJ search with number and summary**, not a completed substitute. A generic official-site link alone does not satisfy that full feature.

## Smallest external dependency to finish the feature

Obtain written reuse terms that specifically cover **user-initiated queries returning identifiers and summaries within this application**, including whether full text may be fetched transiently for an AI summary. This is narrower than requesting a complete historical CENDOJ archive. The terms or licensed provider contract need to establish permitted users and purpose, allowed metadata and content, retention/cache limits, AI processing, attribution, request limits, and the supported delivery interface. A public website login or the user's willingness to use the app does not establish those rights.

Once that scope and interface are available, implement an adapter that executes a bounded query, validates identifiers and official links, normalizes results, and emits an explicit provider-error state on 401/403/429, CAPTCHA, or malformed HTML. Disable it on source blocks instead of retrying through alternative identities or endpoints. Use a supplied official summary when allowed and present; otherwise generate a cited summary from permitted full text and identify it as AI output. Do not promise that a short snippet supports a reliable full-case summary.
