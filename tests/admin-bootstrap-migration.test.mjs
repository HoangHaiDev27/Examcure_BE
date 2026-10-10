import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const execAsync = promisify(execFile);
const baseMigration = readFileSync(new URL("../supabase/migrations/202608310001_examcure_ai.sql", import.meta.url), "utf8");
const bootstrapMigration = readFileSync(new URL("../supabase/migrations/202610100001_admin_bootstrap.sql", import.meta.url), "utf8");
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
// Minimal Supabase-owned schemas for validating the real application migrations
// on PostgreSQL. No network, published port, credentials or live project used.
const schemas = `
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id text primary key, bucket_id text);
`;
const seedUsers = `insert into auth.users (id) values ('${userA}'), ('${userB}');`;

test("bootstrap migration permissions, concurrent grants, durable consumption and rollback", { timeout: 120_000 }, async () => {
  const container = `examcure-admin-bootstrap-${randomUUID().slice(0, 8)}`;
  const docker = (args, input) => execFileSync("docker", args, {
    encoding: "utf8", windowsHide: true, input, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
  }).trim();
  const argsForSql = (database) => ["exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-At"];
  const sql = (database, source) => docker(argsForSql(database), source);
  let started = false;
  try {
    docker(["run", "--rm", "-d", "--name", container, "--network", "none", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16"]);
    started = true;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { docker(["exec", container, "pg_isready", "-U", "postgres"]); ready = true; break; }
      catch { await delay(200); }
    }
    assert.ok(ready, "isolated PostgreSQL must start");
    sql("postgres", "create role anon; create role authenticated; create role service_role;");
    for (const database of ["bootstrap_fresh", "bootstrap_existing", "bootstrap_rollback"]) {
      sql("postgres", `create database ${database};`);
      sql(database, schemas + baseMigration + seedUsers);
      if (database === "bootstrap_existing") sql(database, `update public.profiles set role='admin' where id='${userA}';`);
      sql(database, bootstrapMigration);
    }

    const db = "bootstrap_fresh";
    assert.equal(sql(db, `select has_function_privilege('anon','public.bootstrap_first_admin(uuid)','execute'), has_function_privilege('authenticated','public.bootstrap_first_admin(uuid)','execute'), has_function_privilege('service_role','public.bootstrap_first_admin(uuid)','execute');`), "f|f|t");
    assert.equal(sql(db, `select has_table_privilege('authenticated','public.admin_bootstrap_state','select'), has_column_privilege('authenticated','public.profiles','role','update');`), "f|f");
    assert.throws(() => sql(db, `set role authenticated; select public.bootstrap_first_admin('${userA}');`), /permission denied/);
    assert.equal(sql(db, `select public.bootstrap_first_admin('33333333-3333-4333-8333-333333333333'); select count(*) from public.admin_bootstrap_state;`), "profile_not_found\n0");

    const concurrent = await Promise.all([userA, userB].map(async (userId) => {
      const { stdout } = await execAsync("docker", [...argsForSql(db), "-c", `begin; set local role service_role; select public.bootstrap_first_admin('${userId}'); select pg_sleep(0.25); commit;`], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      return stdout.includes("already_initialized") ? "already_initialized" : stdout.includes("created") ? "created" : stdout;
    }));
    assert.deepEqual(concurrent.sort(), ["already_initialized", "created"]);
    assert.equal(sql(db, "select count(*) from public.profiles where role='admin'; select count(*) from public.admin_bootstrap_state; select count(*) from public.audit_logs where action='admin.bootstrapped';"), "1\n1\n1");
    sql(db, "delete from public.profiles where role='admin';");
    assert.equal(sql(db, `select public.bootstrap_first_admin('${userA}');`), "already_initialized", "deleting the first admin must not reopen bootstrap");

    sql("bootstrap_existing", "update public.profiles set role='student';");
    assert.equal(sql("bootstrap_existing", `select public.bootstrap_first_admin('${userB}');`), "already_initialized", "migration must seal an existing installation");

    const rollback = "bootstrap_rollback";
    sql(rollback, `create function public.reject_bootstrap_audit() returns trigger language plpgsql as $$ begin raise exception 'test audit failure'; end; $$; create trigger reject_audit before insert on public.audit_logs for each row execute function public.reject_bootstrap_audit();`);
    assert.throws(() => sql(rollback, `select public.bootstrap_first_admin('${userA}');`), /test audit failure/);
    assert.equal(sql(rollback, "select count(*) from public.profiles where role='admin'; select count(*) from public.admin_bootstrap_state;"), "0\n0", "failed transaction must grant no role and consume no bootstrap");
    sql(rollback, "drop trigger reject_audit on public.audit_logs;");
    assert.equal(sql(rollback, `select public.bootstrap_first_admin('${userA}');`), "created");
  } finally {
    if (started) docker(["rm", "--force", container]);
  }
});
