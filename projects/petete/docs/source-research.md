# Source research and ingestion contract

Verified on 2026-10-31. This document describes observed official sources and implementation constraints. It does not certify that the complete historical corpus has been downloaded.

## DGT: published consultations from 1997 onward

The Ministry of Finance describes its database as containing binding and nonbinding DGT consultations from 1997 onward. The current PETETE form labels both collections as updated to **2026-09-30**, despite today's date being 2026-10-31. Publication lag is real and must be visible in the app. The requested scope can cover the rulings made available by the official database, not unpublished DGT decisions.

Official entry points:

- Ministry description: https://www.hacienda.gob.es/es-ES/Normativa%20y%20doctrina/Doctrina/paginas/consultasdgt.aspx
- Search: https://petete.tributos.hacienda.gob.es/consultas/
- Official open-data catalog: https://datos.gob.es/es/catalogo/e05250001-consultas-tributarias-de-la-direccion-general-de-tributos
- Source-specific notice: https://petete.tributos.hacienda.gob.es/consultas/avisoLegal.vm
- Reuse conditions: https://www.hacienda.gob.es/es-ES/Paginas/avisolegal.aspx
- Official response on automated access, updated 2026-06-03: https://datos.gob.es/es/solicitud-de-datos/doctrina-tributaria

The catalog exposes HTML, rather than a documented bulk download or JSON API. The official response to a request for more automatic exploitation says the DGT does not plan such an access mechanism. Consequently, the connector is an adapter to the existing public website, not an official supported API. Its response format must be monitored and parser failures must stop progress rather than be interpreted as zero results.

### Observed HTTP sequence

The official page loads `/consultas/script/knoweb.js`, which contains the request paths below. A complete sequence succeeded during verification:

1. Create an HTTP session with a cookie jar.
2. `GET https://petete.tributos.hacienda.gob.es/consultas/`
3. `GET https://petete.tributos.hacienda.gob.es/consultas/do/form`
4. `POST https://petete.tributos.hacienda.gob.es/consultas/do/search`
5. `POST https://petete.tributos.hacienda.gob.es/consultas/do/document`

Use the same cookie jar throughout. Send `X-Requested-With: XMLHttpRequest`, `Referer: https://petete.tributos.hacienda.gob.es/consultas/`, and `Content-Type: application/x-www-form-urlencoded; charset=UTF-8` for POST requests. Fetching a document without full session initialization returned HTTP 401 in this verification. The complete sequence above worked; it is not established which individual header or initialization request is indispensable.

Search parameters observed in the form:

| Parameter | Meaning or example |
| --- | --- |
| `type1=on` | General consultations collection |
| `type2=on` | Binding consultations collection |
| `tab=1` or `tab=2` | Collection for this request |
| `page=1` | One-based result page |
| `NMCMP_1=NUM-CONSULTA` | Ruling number field |
| `VLCMP_1=V2685-21` | Ruling number value |
| `OPCMP_1=.Y` | AND operator |
| `NMCMP_2=FECHA-SALIDA` | Issue date field |
| `VLCMP_2=01/01/2024..31/01/2024` | Inclusive date range in source syntax |
| `NMCMP_3=NORMATIVA` | Legislation field |
| `NMCMP_4=CUESTION-PLANTEADA` | Question field |
| `NMCMP_5=DESCRIPCION-HECHOS` | Facts field |
| `NMCMP_6=FreeText` | Free text field |
| `NMCMP_7=CRITERIO`, `VLCMP_7=INTERES` | Source's interest marker, available from 2022 |
| `cmpOrder=FECHA-SALIDA` | Date ordering |
| `dirOrder=0` or `dirOrder=1` | Ascending or descending |
| `auto=true` | Used by official direct-number lookup |

The response is an HTML fragment. It contains:

- `updateNumResults("2", "1")` for the collection hit count.
- Hidden input `#query`, whose value must be preserved and form-encoded, not rebuilt by the client.
- Hidden input `#order`, for example `NUM-CONSULTA|0`.
- `#total_pages` and input `#current_page`.
- Result cells with IDs such as `doc_39047` and `viewDocument(39047, 2)` handlers.

For subsequent pages the official JavaScript sends `query=<hidden value>&order=<hidden value>&tab=2&page=2` to the search endpoint. Refreshing or reissuing the search before resuming is safer than persisting an old session-bound query indefinitely.

A document request sends `query=<hidden value>&doc=39047&tab=2`. The response contains a `table.document`; its rows use field classes:

| Row class | Content |
| --- | --- |
| `NUM-CONSULTA` | Official ruling reference |
| `ORGANO` | Issuing subdirectorate |
| `FECHA-SALIDA` | `dd/mm/yyyy` issue date |
| `NORMATIVA` | Cited legislation |
| `DESCRIPCION-HECHOS` | Facts |
| `CUESTION-PLANTEADA` | Question |
| `CONTESTACION-COMPL` | Complete answer |

Values are in `td.value`. Preserve paragraph breaks and decode HTML entities. Keep original raw HTML separately when possible so parser changes can be audited. Retain the original complete answer and distinguish any AI output from source text.

Stable human-facing link: `https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=V2685-21`. Internal numeric document IDs are not the user-facing citation.

### Numbering gaps

The current form explicitly marks **0006-26 through 4999-26** in general consultations and **V1690-26 through V4999-26** in binding consultations as empty due to a procedure and numbering change. Therefore a numeric sweep that stops after a run of missing numbers is invalid. Enumerate the search results by date and collection. Never treat a number gap as proof that a year is complete.

### Collection and completeness

Backfill both collections using bounded date windows from 1997-01-01. Persist each window, expected count, observed unique IDs, processed document count, failures, and source update date. Mark a window complete only when every page was enumerated, all documents were parsed, counts reconcile, and no failures remain. Do not infer total historical completeness from successful requests for selected examples.

Run monthly incremental discovery with an overlap, for example the preceding three months. This is a chosen engineering default, not an official publication guarantee. Revisit recent completed windows because the source can publish late or correct records. Upsert by `(source, reference)` and content hash. Store retrieval time independently of issue date and source publication cutoff.

No official rate limit or availability SLA was found. Choose conservative request pacing, bounded retries with backoff, timeouts, explicit handling of 401/403/408/429/5xx, and a resumable queue. A request receiving a block or CAPTCHA must fail visibly; do not bypass it or silently advance coverage.

### Reuse and attribution

The Ministry's general reuse conditions permit commercial and noncommercial reuse of covered information. Preserve meaning, metadata and source dates; cite the Ministry; do not imply endorsement. Use the attribution **Origen de los datos: Ministerio de Hacienda** and retain a link to the reuse notice. Ministry logos, visual identity and website source code have separate restrictions and are not required for this app.

## CENDOJ

Official public search: https://www.poderjudicial.es/search/indexAN.jsp

Current official terms are reproduced by the Ministry of Justice's Centro de Estudios Jurídicos at https://www.cej-mjusticia.es/es/biblioteca/legislacion_online and by the judiciary's legal-notice surface at https://www.prontuario.org/portal/site/sede/menuitem.05fcc984ed5f9d2183e1d754c684caa0/?lang_choosen=gl&vgnextfmt=default&vgnextlocale=gl&vgnextoid=c511e7c32d1c8610VgnVCM1000006f48ac0aRCRD . They limit the public search to personal consultation, prohibit bulk extraction and require the CGPJ/CENDOJ process for database creation or commercial reuse.

Direct retrieval of the public search returned HTTP 403 from the research tool. No public, supported JSON search API or rate limit was verified. Do not represent an untested internal website request as a licensed integration.

The practical application contract is:

- Offer the official public-search link clearly.
- Accept an authorized CENDOJ feed/import only after its permitted use and delivery format are established.
- Retain ruling number, ROJ/ECLI where provided, date, court, complete source text and canonical source URL.
- Enable AI summaries and semantic indexing for imported documents under that authorization.
- Show a source-status message when no authorized CENDOJ corpus has been imported; never display invented case numbers or fake summaries as live results.

Do not rely on Regulation 3/2010 as if it were still operative. Its annulment is discussed in the CGPJ's own report at https://www.poderjudicial.es/stfls/CGPJ/COMISI%C3%93N%20DE%20ESTUDIOS%20E%20INFORMES/INFORMES%20DE%20LEY/FICHERO/Informe%20efectos%20de%20la%20STS.pdf . The current published terms and an actual CENDOJ authorization, rather than the annulled regulation's old fee table, should govern the integration.

## AI reliability contract

Semantic search improves retrieval but cannot guarantee that every important ruling is found. Combine reference lookup, lexical search and semantic candidates; expose date and source filters. Show summaries with their ruling references and official links. Order results chronologically when users need to compare positions, but do not label a difference as a change of legal position merely because dates differ. Different facts, taxes, legislation or effective periods can explain different conclusions. Any proposed change assessment needs cited passages and an explicit uncertainty label.

## Included real sample data

`data/seed-real.json` and `public/demo.json` contain nine selected complete rulings retrieved from the official DGT document endpoint during this session. It is a demonstration subset, not the complete 1997-to-present corpus. Each record retains issue date, source link, original text, extraction time, source cutoff and content hash. The nine short sample summaries were checked against the retrieved source and explicitly marked `editorial`; they are demonstration summaries, not output from a deployed AI service. No CENDOJ rulings are fabricated or bundled from an unlicensed source.
