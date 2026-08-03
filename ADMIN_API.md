# StudyShare Admin API

All admin endpoints require:
1. A valid JWT in `Authorization: Bearer <token>`.
2. The authenticated user's database `role` to be `admin`.

## Endpoints

- `GET /api/admin/check` — verify admin access.
- `GET /api/admin/stats` — dashboard statistics and recent users/files.
- `GET /api/admin/users` — list users and their upload/flashcard counts.
- `PATCH /api/admin/users/:id/role` — change a user's role. Body: `{ "role": "admin" }` or `{ "role": "student" }`.
- `DELETE /api/admin/users/:id` — delete a user. The last administrator cannot be deleted.
- `GET /api/admin/files` — list uploaded materials.
- `DELETE /api/admin/files/:id` — delete a material from the database and, when present, its local physical file.

## Make an existing local account an admin

From the backend folder:

```bash
node scripts/makeAdmin.js YOUR_USERNAME
```

Example:

```bash
node scripts/makeAdmin.js BMS2411880
```

After changing a user's role, log out and log back in on the frontend so the frontend receives a fresh JWT/profile response.

No new npm package is required for these admin changes.
