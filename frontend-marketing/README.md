# Frontend Marketing

Public-facing marketing site for Nora. Built with Next.js 16, React 19, and Tailwind CSS.

## Overview

Runs on `/` behind nginx. Serves the landing page, pricing/support-path page, login, signup, privacy, terms, and a custom 404 page. Does not require authentication.

## Pages

| Route | Description |
|---|---|
| `/` | Landing page — positioning, product facts, feature grid, CTA |
| `/pricing` | Public deployment, support, and commercial-path page |
| `/login` | Login form — email/password + Google/GitHub OAuth |
| `/signup` | Registration form — email + password (first signup on a fresh instance claims the server and becomes platform admin; optional Turnstile/reCAPTCHA challenge) |
| `/privacy` | Privacy policy |
| `/terms` | Terms of service |

## Development

```bash
# Runs automatically in Docker Compose with hot reload
docker compose logs -f frontend-marketing

# Local development (outside Docker)
cd frontend-marketing
npm install
npm run dev   # Starts on port 3000
```

## Styling

Uses Tailwind CSS with a dark-blue gradient theme. Global styles in `styles/globals.css`.
