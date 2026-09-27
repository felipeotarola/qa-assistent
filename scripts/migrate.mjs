import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL;
if (!url) throw new Error("DATABASE_URL is required for database migrations.");

const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
try {
  await migrate(drizzle(sql), {
    migrationsFolder: "server/db/migrations/postgresql",
    migrationsSchema: "public",
    migrationsTable: "pat_migrations",
  });
  await sql`ALTER TABLE public.pat_migrations ENABLE ROW LEVEL SECURITY`;
  console.log("Database migrations applied (pat_ tables).");
} finally {
  await sql.end();
}
