# Choral Music Hub - Backend Server

Modular Express server for user authentication, composition management, and admin operations. Organized into separate folders for maintainability and scalability.

## Directory Structure

```
server/
├── index.js                 # Main app entry point (imports and mounts all routers)
├── lib/                     # Shared libraries for initialization
│   ├── supabaseClient.js   # Supabase client instance
│   └── firebaseAdmin.js    # Firebase Admin SDK initialization
├── middleware/              # Express middleware
│   └── auth.js             # Firebase token verification & admin role checking
├── routes/                  # API route handlers (organized by feature)
│   ├── auth.js             # User registration, sync-user, request-role
│   ├── admin.js            # Admin operations (users, compositions, invites)
│   ├── users.js            # User profile endpoints
│   ├── navbar.js           # Navbar-specific queries (user roles)
│   └── compositions.js     # Composition CRUD endpoints
├── .env                     # Environment variables (private)
├── .env.example             # Example environment variables
└── package.json             # Dependencies & scripts
```

## Environment Setup

Create `.env` file:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-adminsdk-xxxx.json
PORT=3001
ALLOWED_ORIGINS=http://localhost:5173,https://yourdomain.com
```

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase **service role** key (sensitive, required)
- `FIREBASE_SERVICE_ACCOUNT_PATH` - Path to Firebase service account JSON (optional but needed for token verification)
- `PORT` - Server port (default 3001)
- `ALLOWED_ORIGINS` - Comma-separated CORS allowed origins

## Install & Run

```bash
cd server
npm install

# Development (auto-restart)
npm run dev

# Production
npm start
```

Server starts on `http://localhost:3001` (or `$PORT`).

## Route Overview

### Health Check

- `GET /health` - Server status

### Auth Routes (`/api`)

- `POST /api/register` - Register new user by email
- `POST /api/sync-user` - Sync/create user from Firebase auth
- `POST /api/request-role` - Request composer or admin role

### User Routes (`/api`)

- `GET /api/users/:id` - Fetch user by Supabase ID
- `PUT /api/users/:id` - Update user (requires Firebase token)
- `PUT /api/account` - Update authenticated user's account (requires Firebase token)

### Admin Routes (`/api/admin/*`)

All require valid Firebase token + admin role:

- `GET /roles` - List all roles
- `GET /users` - Fetch all users
- `GET /compositions` - Fetch all compositions
- `GET /transactions` - Fetch all purchases
- `GET /invites` - Fetch composer invites
- `GET /composer-requests` - Fetch pending requests
- `GET /stats` - Dashboard stats
- `POST /invites` - Create invite
- `DELETE /invites/:email` - Revoke invite
- `POST /users/:userId/promote-composer` - Promote to composer
- `POST /users/:userId/promote-admin` - Promote to admin
- `POST /users/:userId/suspend` - Suspend user
- `POST /composer-requests/:userId/reject` - Reject request
- `GET /notifications` - Pending actions

### Navbar Routes (`/api/user`)

- `GET /api/user/roles/:firebaseUid` - Fetch user roles by Firebase UID (public)

### Composition Routes (`/api/compositions`)

- `GET /api/compositions` - List published compositions (public)
- `GET /api/compositions/:id` - Fetch composition & increment views (public)
- `POST /api/compositions` - Create new composition (requires Firebase token)

## Authentication

1. Frontend authenticates with Firebase
2. Frontend calls `/api/sync-user` with Firebase UID + email (optional)
3. For protected endpoints, send: `Authorization: Bearer <firebase-id-token>`
4. Server verifies token with Firebase Admin SDK
5. Server checks user roles in Supabase for admin endpoints

## Code Organization

### Modular Routing

Each feature area has its own router file:

- `routes/auth.js` - Registration, user sync, role requests
- `routes/admin.js` - Admin-protected CRUD operations
- `routes/users.js` - User profile management
- `routes/navbar.js` - Public role lookups
- `routes/compositions.js` - Composition management

### Centralized Clients

- `lib/supabaseClient.js` - Single Supabase client (all routes import)
- `lib/firebaseAdmin.js` - Firebase Admin SDK initialization

### Middleware Chain

- `verifyFirebaseToken` - Validates Firebase ID token from header
- `adminOnly` - Checks for admin role (requires verifyFirebaseToken)

Admin routes use: `router.use(verifyFirebaseToken, adminOnly)`

## Adding New Routes

1. Create `routes/feature.js`:

```javascript
import express from "express";
import { supabase } from "../lib/supabaseClient.js";

const router = express.Router();
router.get("/endpoint", async (req, res) => {
  /* ... */
});
export default router;
```

2. Import in `index.js`:

```javascript
import featureRouter from "./routes/feature.js";
```

3. Mount in `index.js`:

```javascript
app.use("/api/feature", featureRouter);
```

4. For admin protection, add middleware:

```javascript
import { verifyFirebaseToken, adminOnly } from "../middleware/auth.js";
router.use(verifyFirebaseToken, adminOnly);
```

## Testing

### Health check

```bash
curl http://localhost:3001/health
```

### Register user

```bash
curl -X POST http://localhost:3001/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","displayName":"Test"}'
```

### Sync user (requires Firebase token)

```bash
curl -X POST http://localhost:3001/api/sync-user \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <firebase-token>" \
  -d '{"firebaseUid":"uid123","email":"user@example.com"}'
```

## Error Responses

All routes return consistent format:

```json
{
  "message": "Human-readable error",
  "error": "error code or detail"
}
```

Status codes:

- `200` - Success
- `201` - Created
- `400` - Bad request
- `401` - Unauthorized (missing/invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not found
- `409` - Conflict (e.g., user exists)
- `500` - Server error

## Logging

All routes log with `[route-name]` prefix:

```javascriptpowershell
Invoke-RestMethod -Uri 'http://localhost:3001/api/sync-from-firebase' -Method Post -Body (ConvertTo-Json @{maxResults=100}) -ContentType 'application/json'
```

Security

- Keep `SUPABASE_SERVICE_ROLE_KEY` secret. Do not commit `.env` with real keys.
- Consider running this server in a secure environment; restrict access to the endpoints.

Troubleshooting

- If you see CORS errors from the browser, ensure the server is running and reachable through your tunnel (ngrok). The server returns CORS headers for any origin.
- If Supabase returns authentication/permission errors, confirm the `SUPABASE_SERVICE_ROLE_KEY` is a valid service role key.

License: MIT# Murekefu Sync Server

A Node.js/Express server that syncs Firebase users to Supabase, with support for role assignment and batch operations.

## Setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Set environment variables

Create a `.env` file in the `server/` folder:

```
SUPABASE_URL=https://your-supabase-instance.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

**Important:** The `SUPABASE_SERVICE_ROLE_KEY` is sensitive and should never be committed to Git. It's used server-side to bypass row-level security policies.

### 3. Run the server locally

```bash
npm start
```

The server will start on `http://localhost:3001`.

### 4. Expose via ngrok

In a new terminal:

```bash
ngrok http 3001
```

ngrok will output a URL like `https://abc123.ngrok.io`. Use this as your `VITE_API_BASE_URL` in the frontend.

### 5. Update frontend environment

In your frontend `.env` or `.env.local`:

```
VITE_API_BASE_URL=https://abc123.ngrok.io
```

## Endpoints

### Health Check

```
GET /health
```

Returns: `{ status: 'ok', message: 'Server is running' }`

### Sync Single User

```
POST /api/sync-user

Request body:
{
  "firebaseUid": "user_firebase_id",
  "email": "user@example.com",
  "displayName": "User Name",        // optional
  "phone": "+1234567890",            // optional
  "avatarUrl": "https://...",        // optional
  "role": "buyer"                    // optional: 'buyer' | 'composer' | 'admin'
}

Response:
{
  "id": "uuid-of-user",
  "firebaseUid": "user_firebase_id",
  "email": "user@example.com",
  "role": "buyer",
  "message": "User synced successfully"
}
```

### Batch Sync Users

```
POST /api/sync-users-batch

Request body:
{
  "users": [
    {
      "firebaseUid": "user1_id",
      "email": "user1@example.com",
      "role": "buyer"
    },
    {
      "firebaseUid": "user2_id",
      "email": "user2@example.com",
      "role": "composer"
    }
  ]
}

Response:
{
  "total": 2,
  "successful": 2,
  "failed": 0,
  "results": [
    { "firebaseUid": "user1_id", "email": "user1@example.com", "id": "uuid1", "status": "success" },
    { "firebaseUid": "user2_id", "email": "user2@example.com", "id": "uuid2", "status": "success" }
  ]
}
```

## Development

Watch mode (auto-restart on file changes):

```bash
npm run dev
```

## How It Works

1. **Client sends request** to `/api/sync-user` with Firebase user details
2. **Server validates** the request and checks if user exists in Supabase
3. **If user exists**: Updates their profile info
4. **If user is new**: Creates a new user record with the service role key (bypasses RLS)
5. **Assigns role**: If a role is specified, creates the role assignment and related records
6. **Returns success** with the Supabase user ID

This approach allows the frontend to work with row-level security policies while still being able to create and manage users on the backend.
