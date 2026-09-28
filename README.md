# VMS Autopilot

AI-Powered Marketing Automation Platform.

This package contains the approved VMS Autopilot dashboard interface exported from the Codex AppDeploy prototype, plus the product requirements and access-control material.

## Interface

The interface is in the interface/ folder and uses React + Vite + TypeScript.

The visual design is intentionally preserved:

- Navy admin sidebar
- Violet and teal accent colors
- Agency overview KPI cards
- AI Operations Monitor
- Leads and ROAS chart
- Client Workspaces table
- Approval Queue
- Workspace selector

The prototype interactions include module navigation, workspace switching, adding a client row, and approving items in the queue.

## Run the interface

From the interface/ folder:

1. Install dependencies with npm install.
2. Start the local preview with npm run dev.
3. Open the local URL shown by Vite.

The interface expects the image asset at:

public/resources/ai-working-247.png

Add the supplied AI working 24/7 icon at that path before running locally.

## Included material

- interface/ — dashboard source
- docs/ACCESS-MATRIX.md — Admin and Client access rules
- CLAUDE-CODE-PROMPT.md — prompt for continuing implementation in Claude Code
- ../VMS-AUTOPILOT-PRD.md — complete product requirements document

## Important

This is the frontend prototype. Real authentication, database, OAuth integrations, Buffer, social publishing, paid ads, domain operations, SEO/GEO crawling, billing, and 24-hour monitoring still need backend implementation.
