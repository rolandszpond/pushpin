import postgres from 'postgres'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL env var is required')

export const sql = postgres(process.env.DATABASE_URL, {
    transform: postgres.camel,
    max: 10,
})
