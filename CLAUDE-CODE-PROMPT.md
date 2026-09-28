# Claude Code continuation prompt

Build VMS Autopilot — AI-Powered Marketing Automation Platform from this package.

Keep the existing dashboard visual design unchanged. Treat the files in interface/ as the approved UI baseline.

Implement the product in phases:

1. Authentication, Admin workspace, Client workspace, role-based permissions, and audit log.
2. SEO/GEO audit reports with Client read/run access but no direct modification.
3. Paid Ads and Domain modules with Admin-controlled permissions and approval flows.
4. Buffer OAuth, Free/Paid channel status, social calendar, approval, and publishing.
5. Website builder/provider selection, domain search, deployment, and WhatsApp lead forms.
6. Admin-only AI execution, safe repair/restart, health checks every 24 hours, and notifications.

Rules:

- Do not change the approved visual language without explicit approval.
- Client AI must remain read-only and must not execute commands or modify data.
- Only Admin can grant or revoke permissions.
- Never expose OAuth tokens, API keys, or registrar credentials to clients.
- Log every sensitive action.
- Require explicit confirmation for destructive, billing, DNS, publishing, or ad-budget actions.
- Keep the interface mobile-friendly and accessible.
