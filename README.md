# IT Service Desk — Backend API

Independent Node.js + Express REST API. Deployable on its own (separate host/domain from the frontend).

## Stack

- Node.js 18+
- Express
- PostgreSQL (`pg`)
- JWT auth, bcrypt passwords, Nodemailer

## Setup

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Long random secret |
| `FRONTEND_URL` | Yes | CORS + password-setup email links (e.g. `http://localhost:3001`) |
| `PORT` | No | Default `3303` |
| `NODE_ENV` | Prod | Set `production` on live servers |
| `SMTP_*` | No | If empty, password emails are logged to the console |

Create the database:

```sql
CREATE DATABASE integriti_helpdesk;
```

```bash
npm install
npm run migrate
```

### Local only (dummy data)

```bash
npm run seed
npm run dev
```

Seed is blocked when `NODE_ENV=production`. Local seed users use `@getnada.com` emails.

### Production

```bash
npm run migrate
# Do NOT run npm run seed
npm start
```

Bootstrap admin + default departments/catalog with SQL:

- See `../docs/production-bootstrap.sql`
- Guide: `../docs/Integriti-Production-Bootstrap-Guide.pdf`

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start with nodemon |
| `npm start` | Start production server |
| `npm run migrate` | Create / update tables |
| `npm run seed` | Local dummy data only |

## API base

Default: `http://localhost:3303`

Routes are under `/api/...` (auth, users, roles, tickets, requisitions, etc.).

Authorization is enforced on protected endpoints via `role → role_permissions → modules`.
