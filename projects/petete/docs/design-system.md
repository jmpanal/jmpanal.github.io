# Petete interface

The primary concept is a legal research workspace. It uses a true white canvas, a fixed navy navigation rail, a split result list and document reader, restrained blue selection, and a serif title paired with sans-serif controls. The implementation keeps UI text and controls in code.

## Tokens and structure

- Canvas: `#ffffff`; rail: `#14283d`; action: `#1766b5`; text: `#101c2e`; borders: `#d7dfe8`; selected result: `#e5f0ff`.
- Headings: Georgia with Times New Roman fallback; UI and document text: Arial with Helvetica fallback.
- Desktop rail: 230px. Workspace gutter: 30px. Result column: 38%. Reader gutter: 30px. Radius: 4px.
- Reusable controls: buttons, source tabs, labeled filters, result row, source link, metadata list, summary block, document details, timeline, tables, form inputs, modal.
- Navigation icons use the same Lucide outline family with 1.6px strokes. Buttons use small 16–20px icons.
- Mobile below 760px uses a compact navy header, drawer navigation, and sequential results/document reading with a back action. Filters become a two-column grid.

## Required content differences from the concept

The concept contains illustrative consultation numbers, dates, result counts and text. Production uses only the verified real seed or server records and computes counts. The demo starts without an imposed query so the actual sample remains visible. Summary status is explicit: editorial reading synthesis, literal extract or AI-generated summary. Chronology is labeled as the order of search results, without asserting doctrinal change or identical facts.

The source data available for the demo requires the additional honest coverage state, authenticated login, real admin tools and official CENDOJ search fallback. These requested workflows extend the same component system. They do not use invented judicial records or pretend login/admin state.

## Verification

The main agent owns browser verification against the concept, mobile checks and final comparison ledger. This file records implementation design choices, not a claim that screenshots have already passed review.
