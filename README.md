# InvoiceFlow

InvoiceFlow is a full-stack invoicing workspace for small teams. It manages clients, saved services, GST invoices, and payment records in one live dashboard.

## Features

- Live dashboard for monthly paid revenue, outstanding balances, overdue invoices, clients, and recent invoice activity
- Client CRUD with duplicate checks and safeguards for clients linked to invoices
- Product and service catalog with prices, units, and GST rates
- Invoice creation with server-calculated line totals and tax, automatic invoice numbers, due dates, notes, and searchable statuses
- Invoice updates, print-to-PDF, payment history, and safe deletion rules
- Partial and full payment tracking with overpayment prevention
- Role-based access for Owner, Accountant, and Viewer
- Server-Sent Events refresh dashboard data immediately after invoice, client, or catalog changes
- Responsive React UI with browser-print invoice output

## Stack

- **Frontend:** React 19, TypeScript, Vite
- **Backend:** Node.js 20+, Express 5, Zod validation, JWT session cookie
- **Database:** PostgreSQL-compatible PGlite for local development. The PGlite data directory is persisted at `server/data/` and excluded from Git. Set `DATABASE_URL` to PostgreSQL when deploying.

## Run locally

```bash
npm install
Copy-Item .env.example .env
npm run dev
```

Open the Vite URL shown in the terminal (normally <http://localhost:5173>). The API uses <http://127.0.0.1:4001>. If the Vite port is already busy, Vite automatically selects the next available port. The local launcher starts the embedded database, API, and UI together.

For PowerShell, `Copy-Item` is the built-in environment-file copy command. On macOS/Linux, use `cp .env.example .env` instead.

### Demo sign-in

| Role | Email | Password |
| --- | --- | --- |
| Owner | `owner@invoiceflow.local` | `InvoiceFlow!2026` |
| Accountant | `accounts@invoiceflow.local` | `InvoiceFlow!2026` |
| Viewer | `viewer@invoiceflow.local` | `InvoiceFlow!2026` |

The demo workspace is seeded automatically the first time the database starts. Change the demo passwords before exposing an installation to other users.

## Verify

```bash
npm run build
npm run test:api
```

The API smoke check covers authentication and roles, client and service CRUD, SSE updates, invoice creation/update/search, GST calculations, payment state changes, overpayment rejection, deletion safeguards, and session logout. It removes its temporary QA rows after the run.

## API overview

All endpoints are prefixed with `/api` and require the session cookie except health and sign-in/out.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Service/database health |
| POST | `/auth/login` | Sign in |
| GET / POST | `/clients` | List/create clients |
| PATCH / DELETE | `/clients/:id` | Update/delete clients (delete is owner-only) |
| GET / POST | `/products` | List/create products and services |
| PATCH / DELETE | `/products/:id` | Update/archive catalog items (archive is owner-only) |
| GET / POST | `/invoices` | Search/list and create invoices |
| GET / PATCH / DELETE | `/invoices/:id` | Read/update/delete invoice |
| POST | `/invoices/:id/payments` | Record a payment |
| GET | `/dashboard` | Workspace metrics |
| GET | `/events` | Authenticated real-time SSE stream |

## Production notes

The development launcher runs a local PGlite-compatible PostgreSQL server. For a hosted setup, configure a managed PostgreSQL database, use a long random `JWT_SECRET`, set `COOKIE_SECURE=true` behind HTTPS, and build the frontend with `npm run build`. This starter has no email delivery integration; invoice reminders can be added through a mail provider.
