// vitest setup — run before any test module imports the server (which reads
// config + opens the DB pool). Point the pool at the isolated test database so
// tests never touch the development audit log or demo data.
process.env.PGDATABASE = process.env.PGDATABASE_TEST ?? 'mun_guardian_test';
